/**
 * Phase 11 — Chat hook with client-side tool execution.
 *
 * Wraps `@ai-sdk/react` `useChat` with a custom {@link DefaultChatTransport} that
 * posts to the server chat route. Tool *definitions* live on the server (via
 * `getToolContracts`); tool *execution* happens locally in {@link executeLocalTool}.
 *
 * The multi-step agent loop:
 * 1. User sends a message → server streams assistant text + tool-call parts.
 * 2. `onToolCall` runs each tool locally and calls `addToolOutput`.
 * 3. `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls` re-posts
 *    once every tool call in the last assistant message has output, so the model
 *    can continue reasoning without another user turn.
 *
 * `prepareSendMessagesRequest` trims the payload: for tool-continuation turns it
 * sends `[previousUser, assistantWithToolCalls]` instead of the full history,
 * because the server merges against stored session messages.
 */
import { useMemo, useCallback, useRef, useEffect, useState } from "react";
import { useChat as useAiChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type ChatTransport,
  type InferUITools,
  lastAssistantMessageIsCompleteWithToolCalls,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { Mode, toolInputSchemas, type ModeType, type SupportedChatModelId, type ToolContracts } from "@mocode/shared";
import { apiClient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";
import { getAuth } from "../lib/auth";
import { executeLocalTool } from "../lib/local-tools";
import { requiresApproval, rememberSessionAllow } from "../lib/bash-approval";
import { requestBashApproval } from "../lib/bash-approval-ui";
import { executeMcpToolCall } from "../lib/mcp-tool-call";
import { requestMcpApproval } from "../lib/mcp-approval-ui";
import { getMcpManager } from "../mcp/manager";
import type { McpManager } from "../mcp/manager";
import { looksLikeMcpToolName } from "../mcp/heuristics";
import { useDialog } from "../providers/dialog";
import { isLocalMode } from "../lib/local-mode";
import { updateLocalSession } from "../lib/local-sessions";
import { resolveChatModel } from "../lib/local-model";
import { LocalChatTransport, stripIncompleteAssistantMessages } from "../lib/local-chat-transport";
import { hasVisibleAssistantContent } from "@mocode/shared";
import { buildSystemPrompt } from "../lib/system-prompt";
import { expandSkillSlashMessage } from "../lib/skills/expand";
import { loadMergedSkills } from "../lib/skills/loader";
import { getCachedSkills } from "../lib/skills/registry";
import {
  collectPendingToolCallIds,
  finalizeInterruptedAssistant,
  detectResumeEligibility,
  resolveResumeTransport,
  shouldSkipInterruptedToolOutput,
  trimMessagesForRegenerate,
  type ResumeEligibility,
} from "../lib/stream-interrupt";
import { formatChatStreamError } from "../lib/stream-error";
import { scheduleLocalSessionPersist } from "./use-chat-persist";
import { killTrackedToolProcesses } from "../lib/tool-process-registry";
import {
  requiresLocalWriteApproval,
  LOCAL_WRITE_REJECT_ERROR_TEXT,
} from "../lib/local-write-approval";
import { requestLocalWriteApproval } from "../lib/local-write-approval-ui";
import { runToolPipeline } from "../lib/tool-pipeline";
import { loadMergedHooksConfig } from "../lib/hooks/loader";
import { runMatchingHooks, type HookPayload } from "../lib/hooks/runner";
import { useToast } from "../providers/toast";

/**
 * Multi-sentence model guidance returned when the user rejects a blocklisted bash command.
 * Kept as a plain string (not JSON) — the AI SDK passes it verbatim as tool output-error.
 *
 * Each sentence maps to a Rule 11 constraint in system-prompt.ts (Phase 01, plans 05–06):
 * 1. Clarifies this is user rejection, not a runtime/shell failure.
 * 2. No automatic retry — user must explicitly re-request in a new message.
 * 3. Chat is not a permission gate; TUI dialog was the only approval step.
 * 4. Model should acknowledge and suggest alternatives instead of re-asking.
 * 5. Positive retry path: new user message → bash tool call → TUI dialog again.
 * 6. Manual fallback: user runs the command outside the agent.
 * 7. Hard ban: chat cannot unlock retry — do not wait for or solicit typed confirm.
 */
export const BASH_REJECT_ERROR_TEXT =
  "User rejected this command in the TUI approval dialog — this is not a runtime failure. " +
  "Do not retry the same command unless the user explicitly requests it again in a new message. " +
  "Do not ask for typed chat confirmation to proceed; chat is not a permission gate and the TUI dialog was the only approval step. " +
  "Acknowledge the rejection and suggest safer alternatives or ask what to do next. " +
  "To run the same command again, the user must ask again in a new message — that will invoke bash and show the TUI approval dialog again. " +
  "Alternatively, the user can run the command manually outside the agent. " +
  "There is no chat confirmation path to proceed — do not wait for or solicit chat confirm to retry.";

export type ChatMessageMetadata = {
  /** PLAN or BUILD — controls which tools the server exposes and CLI may run. */
  mode?: ModeType;
  model?: SupportedChatModelId | string;
  /** Wall-clock time for the assistant turn, set on stream finish. */
  durationMs?: number;
  usage?: LanguageModelUsage;
};

/** Maps shared {@link ToolContracts} to UI message tool slots (output is unknown until local exec). */
type ChatTools = {
  [Name in keyof InferUITools<ToolContracts>]: {
    input: InferUITools<ToolContracts>[Name]["input"];
    output: unknown;
  };
};

export type Message = UIMessage<ChatMessageMetadata, never, ChatTools>;

/** Read live Chat store (not React closure snapshot). */
function snapshotChatMessages(chat: {
  messages: Message[];
  setMessages: (fn: (messages: Message[]) => Message[]) => void;
}): Message[] {
  let snapshot = chat.messages;
  chat.setMessages((msgs) => {
    snapshot = msgs;
    return msgs;
  });
  return snapshot;
}

async function persistSessionMessages(sessionId: string, messages: Message[]): Promise<void> {
  const safeMessages = stripIncompleteAssistantMessages(messages);
  if (isLocalMode()) {
    updateLocalSession(sessionId, safeMessages);
    return;
  }

  const res = await apiClient.sessions[":id"].$patch({
    param: { id: sessionId },
    json: { messages: safeMessages as unknown as Record<string, unknown>[] },
  });
  if (!res.ok) {
    throw new Error(await getErrorMessage(res));
  }
}

function reportPersistError(
  onPersistError: ((message: string) => void) | undefined,
  sessionId: string,
  error: unknown,
): void {
  if (
    isLocalMode() &&
    error instanceof Error &&
    error.message.startsWith("Local session not found:")
  ) {
    return;
  }
  console.error("Failed to persist session", { sessionId, error });
  if (onPersistError) {
    onPersistError(error instanceof Error ? error.message : "Failed to save session");
  }
}

function resolveLoadedSkills() {
  const cached = getCachedSkills();
  if (cached.length > 0) {
    return cached;
  }
  return loadMergedSkills(process.cwd());
}

export function useChat(
  sessionId: string,
  initialMessages: Message[],
  options?: { onPersistError?: (message: string) => void },
) {
  const dialog = useDialog();
  const toast = useToast();
  // Session-scoped allowlist: "Allow for this session" skips future prompts for the same
  // normalized command string. Owned here (not a global singleton) so each chat session
  // resets on mount and cannot leak across sessions (Phase 01, plan 02).
  const sessionAllowRef = useRef(new Set<string>());
  // MCP write approval session allowlist — keyed by full `mcp__<server>__<tool>` (Phase 02, D-15).
  // Separate from bash allowlist because MCP tools are named, not normalized shell strings.
  const sessionMcpAllowRef = useRef(new Set<string>());
  /** Tool calls Esc'd while local exec is in-flight — skip late addToolOutput + auto-send. */
  const skipToolOutputIdsRef = useRef(new Set<string>());
  /** Session allowlist for writeFile/editFile after "Allow for this session". */
  const sessionWriteAllowRef = useRef(new Set<string>());
  const hooksConfigRef = useRef<ReturnType<typeof loadMergedHooksConfig> | null>(null);
  /** Blocks sendAutomaticallyWhen after Esc finalizes tool output-error parts. */
  const turnInterruptedRef = useRef(false);
  const [turnInterrupted, setTurnInterrupted] = useState(false);
  const onPersistErrorRef = useRef(options?.onPersistError);
  onPersistErrorRef.current = options?.onPersistError;

  const transport = useMemo(() => {
    // BYOK: inference + tool schema merge run in-process; MCP execution stays in onToolCall below.
    if (isLocalMode()) {
      return new LocalChatTransport({
        resolveModel: resolveChatModel,
        getMcpManager,
        buildSystemPrompt: (params) =>
          buildSystemPrompt({
            ...params,
            skills: resolveLoadedSkills(),
          }),
      }) as ChatTransport<Message>;
    }

    const chatFetch = (async (input, init) => {
        const response = await globalThis.fetch(input, init);
        if (!response.ok) {
          const message = await getErrorMessage(response);
          throw new Error(message);
        }
        return response;
      }) as typeof globalThis.fetch;

    return new DefaultChatTransport<Message>({
      api: apiClient.chat.$url().toString(),
      fetch: chatFetch,
      headers() {
        const auth = getAuth();
        return auth ? { Authorization: `Bearer ${auth.token}` } : new Headers();
      },
      prepareReconnectToStreamRequest({ id }) {
        return {
          api: apiClient.chat[":id"].stream.$url({ param: { id } }).toString(),
          headers: (() => {
            const auth = getAuth();
            return auth ? { Authorization: `Bearer ${auth.token}` } : new Headers();
          })(),
        };
      },
      prepareSendMessagesRequest({ messages }) {
        const message = messages[messages.length - 1];
        if (!message) throw new Error("No message to send");

        // Fall back to the most recent message that carried mode/model metadata
        // (tool-continuation assistant messages may not repeat them).
        const metadata = messages.findLast(
          (m) => m.metadata?.mode && m.metadata?.model,
        )?.metadata;
        const requestMode = message.metadata?.mode ?? metadata?.mode ?? Mode.BUILD;
        const previousMessage = messages[messages.length - 2];
        // Tool loop: server already has history; only ship the pair that changed.
        const requestMessages =
          message.role === "assistant" && previousMessage?.role === "user"
            ? [previousMessage, message]
            : [message];

        let mcpTools: ReturnType<McpManager["getToolDefinitions"]> = [];
        try {
          mcpTools = getMcpManager().getToolDefinitions(requestMode);
        } catch (error) {
          console.error("Failed to load MCP tool definitions", error);
        }

        return {
          body: {
            id: sessionId,
            messages: requestMessages,
            mode: requestMode,
            model: message.metadata?.model ?? metadata?.model,
            // Phase 02 D-06: CLI discovers MCP tools locally; server merges schemas into streamText only.
            // Execution remains on CLI — server never calls MCP SDK.
            mcpTools,
          },
        };
      },
    });
  }, [sessionId]);

  const chat = useAiChat<Message>({
    id: sessionId,
    messages: initialMessages,
    transport,
    async onToolCall({ toolCall }) {
      const shouldSkipToolOutput = () =>
        shouldSkipInterruptedToolOutput(toolCall.toolCallId, skipToolOutputIdsRef.current);

      // Tool-continuation assistant messages may omit metadata — scan backward like transport.
      const mode =
        chat.messages.findLast((message) => message.metadata?.mode)?.metadata?.mode ??
        Mode.BUILD;

      const isMcpCall = looksLikeMcpToolName(toolCall.toolName);

      // Phase 04 (04-03): Task handler lands later — stub avoids hanging the tool loop.
      if (toolCall.toolName === "task") {
        if (shouldSkipToolOutput()) return;
        chat.addToolOutput({
          tool: "task",
          toolCallId: toolCall.toolCallId,
          state: "output-error",
          errorText: "Task tool not yet implemented",
        });
        return;
      }

      // AI SDK marks tools without static execute as `dynamic`. MCP tools are dynamic but must
      // still run on the CLI — only skip unrelated dynamic tools we do not own.
      if (toolCall.dynamic && !isMcpCall) return;

      const getHooksConfig = () => {
        if (!hooksConfigRef.current) {
          try {
            hooksConfigRef.current = loadMergedHooksConfig(process.cwd());
          } catch {
            hooksConfigRef.current = { hooks: [] };
          }
        }
        return hooksConfigRef.current;
      };

      const hooksConfig = getHooksConfig();

      const makeHookPayload = (event: HookPayload["event"]): HookPayload => ({
        toolName: toolCall.toolName,
        input: toolCall.input,
        sessionId,
        mode,
        cwd: process.cwd(),
        event,
      });

      const addMcpToolOutput = chat.addToolOutput as (params: {
        toolCallId: string;
        state?: "output-available" | "output-error";
        output?: unknown;
        errorText?: string;
      }) => void;

      const emitToolError = (errorText: string) => {
        if (shouldSkipToolOutput()) return;
        if (isMcpCall) {
          addMcpToolOutput({
            toolCallId: toolCall.toolCallId,
            state: "output-error",
            errorText,
          });
          return;
        }
        chat.addToolOutput({
          tool: toolCall.toolName as keyof ChatTools,
          toolCallId: toolCall.toolCallId,
          state: "output-error",
          errorText,
        });
      };

      try {
        const pipelineResult = await runToolPipeline({
          toolCall: {
            toolName: toolCall.toolName,
            toolCallId: toolCall.toolCallId,
            input: toolCall.input,
          },
          beforeHook: async () => {
            const hookResult = await runMatchingHooks(
              "beforeToolCall",
              toolCall.toolName,
              makeHookPayload("beforeToolCall"),
              hooksConfig.hooks,
            );
            if (hookResult && !hookResult.allowed) {
              return { allowed: false, reason: hookResult.reason };
            }
            return { allowed: true };
          },
          approvalGate: async () => {
            if (isMcpCall) {
              return { approved: true };
            }

            if (toolCall.toolName === "bash" && mode === Mode.BUILD) {
              const { command } = toolInputSchemas.bash.parse(toolCall.input);
              if (requiresApproval(command, sessionAllowRef.current)) {
                const verdict = await requestBashApproval(dialog, command);
                if (verdict === "reject") {
                  return { approved: false, reason: BASH_REJECT_ERROR_TEXT };
                }
                if (verdict === "allow-session") {
                  rememberSessionAllow(sessionAllowRef.current, command);
                }
              }
            }

            if (
              requiresLocalWriteApproval(
                toolCall.toolName,
                mode,
                sessionWriteAllowRef.current,
              )
            ) {
              const verdict = await requestLocalWriteApproval(
                dialog,
                toolCall.toolName,
                toolCall.input,
              );
              if (verdict === "reject") {
                return { approved: false, reason: LOCAL_WRITE_REJECT_ERROR_TEXT };
              }
              if (verdict === "allow-session") {
                sessionWriteAllowRef.current.add(toolCall.toolName);
              }
            }

            return { approved: true };
          },
          executeTool: async () => {
            if (isMcpCall) {
              await executeMcpToolCall(
                {
                  toolName: toolCall.toolName,
                  toolCallId: toolCall.toolCallId,
                  input: toolCall.input,
                },
                {
                  getMcpManager,
                  requestMcpApproval,
                  sessionMcpAllowRef: sessionMcpAllowRef.current,
                  mode,
                  dialog,
                  addToolOutput: (params) => {
                    if (shouldSkipToolOutput()) return;
                    if (params.state === "output-error") {
                      addMcpToolOutput({
                        toolCallId: params.toolCallId,
                        state: "output-error",
                        errorText: params.errorText ?? "MCP tool call failed",
                      });
                      return;
                    }
                    addMcpToolOutput({
                      toolCallId: params.toolCallId,
                      output: params.output,
                    });
                  },
                },
              );
              return;
            }

            const output = await executeLocalTool(toolCall.toolName, toolCall.input, mode);
            if (shouldSkipToolOutput()) return;
            chat.addToolOutput({
              tool: toolCall.toolName as keyof ChatTools,
              toolCallId: toolCall.toolCallId,
              output,
            });
          },
          afterHook: async () => {
            await runMatchingHooks(
              "afterToolCall",
              toolCall.toolName,
              makeHookPayload("afterToolCall"),
              hooksConfig.hooks,
            );
          },
        });

        if (pipelineResult.blocked) {
          const errorText = pipelineResult.reason ?? "Tool execution blocked";
          emitToolError(errorText);
          if (pipelineResult.blockedBy === "hook") {
            toast.show({
              variant: "error",
              message: `Hook blocked ${toolCall.toolName}: ${errorText}`,
            });
          }
        }
      } catch (error) {
        emitToolError(error instanceof Error ? error.message : String(error));
      }
    },
    sendAutomaticallyWhen: (params) => {
      if (turnInterruptedRef.current) return false;
      return lastAssistantMessageIsCompleteWithToolCalls(params);
    },
  });

  useEffect(() => {
    if (!isLocalMode()) return;
    if (chat.status !== "streaming" && chat.status !== "submitted" && chat.status !== "ready") {
      return;
    }

    scheduleLocalSessionPersist({
      status: chat.status,
      sessionId,
      messages: chat.messages,
      debounceMs: 400,
      persistFn: () => {
        void persistSessionMessages(sessionId, chat.messages).catch((error) => {
          reportPersistError(onPersistErrorRef.current, sessionId, error);
        });
      },
    });
  }, [sessionId, chat.messages, chat.status]);

  // Re-apply tool Interrupted markers after chat.stop() settles (SDK may overwrite setMessages).
  useEffect(() => {
    if (!turnInterrupted) return;
    const pending = collectPendingToolCallIds(chat.messages);
    if (pending.length === 0) return;

    chat.setMessages((msgs) => finalizeInterruptedAssistant(msgs));
  }, [turnInterrupted, chat.messages, chat.setMessages]);

  const interrupt = useCallback(() => {
    turnInterruptedRef.current = true;
    setTurnInterrupted(true);
    killTrackedToolProcesses();

    const snapshot = snapshotChatMessages(chat);
    for (const toolCallId of collectPendingToolCallIds(snapshot)) {
      skipToolOutputIdsRef.current.add(toolCallId);
    }

    chat.stop();

    chat.setMessages((msgs) => finalizeInterruptedAssistant(msgs));

    queueMicrotask(() => {
      const live = snapshotChatMessages(chat);
      const finalized = finalizeInterruptedAssistant(live);
      void persistSessionMessages(sessionId, finalized).catch((error) => {
        reportPersistError(onPersistErrorRef.current, sessionId, error);
      });

      const pendingAfter = collectPendingToolCallIds(finalized);
      if (pendingAfter.length > 0) {
        chat.setMessages((msgs) => finalizeInterruptedAssistant(msgs));
      }
    });
  }, [chat, sessionId]);

  const getEligibility = useCallback((): ResumeEligibility => {
    return detectResumeEligibility(chat.messages, chat.status);
  }, [chat.messages, chat.status]);

  const continueGeneration = useCallback(
    async (params: { mode: ModeType; model: SupportedChatModelId }) => {
      turnInterruptedRef.current = false;
      setTurnInterrupted(false);
      skipToolOutputIdsRef.current.clear();
      const eligibility = detectResumeEligibility(chat.messages, chat.status);
      const action = resolveResumeTransport(eligibility);
      if (action === "none") return;

      chat.clearError();

      const lastUser = chat.messages.findLast((message) => message.role === "user");
      if (!lastUser) return;

      const trimmed = trimMessagesForRegenerate(chat.messages, params);
      if (!trimmed) return;
      chat.setMessages(trimmed);

      await chat.regenerate({ messageId: lastUser.id });

      const liveAfter = snapshotChatMessages(chat);
      const liveLast = liveAfter.at(-1);
      if (liveLast?.role === "assistant" && !hasVisibleAssistantContent(liveLast)) {
        chat.setMessages(stripIncompleteAssistantMessages(liveAfter));
        await chat.regenerate({ messageId: lastUser.id });
      }
    },
    [chat],
  );

  const resumeStream = useCallback(async () => {
    await chat.resumeStream();
  }, [chat.resumeStream]);

  useEffect(() => {
    const pruned = stripIncompleteAssistantMessages(chat.messages);
    if (pruned.length === chat.messages.length) return;

    chat.setMessages(pruned);
  }, [chat.messages, chat.setMessages]);

  const submit = useCallback(
    (params: { userText: string; mode: ModeType; model: SupportedChatModelId }) => {
      turnInterruptedRef.current = false;
      setTurnInterrupted(false);
      skipToolOutputIdsRef.current.clear();
      const skills = resolveLoadedSkills();
      const userText = expandSkillSlashMessage({ text: params.userText, skills });
      return chat.sendMessage({
        text: userText,
        metadata: {
          mode: params.mode,
          model: params.model,
        },
      });
    },
    [chat.sendMessage],
  );

  return {
    messages: chat.messages,
    status: chat.status,
    turnInterrupted,
    error: chat.error
      ? new Error(formatChatStreamError(chat.error))
      : undefined,
    submit,
    abort: interrupt,
    interrupt,
    continueGeneration,
    resumeStream,
    getEligibility,
    setMessages: chat.setMessages,
  };
};