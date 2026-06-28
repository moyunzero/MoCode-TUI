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
import { useMemo, useCallback, useRef, useEffect } from "react";
import { useChat as useAiChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type InferUITools,
  lastAssistantMessageIsCompleteWithToolCalls,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { Mode, toolInputSchemas, type ModeType, type SupportedChatModelId, type ToolContracts } from "@mocode/shared";
import { apiClient } from "../lib/api-client";
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
import { buildSystemPrompt } from "../lib/system-prompt";

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

export function useChat(sessionId: string, initialMessages: Message[]) {
  const dialog = useDialog();
  // Session-scoped allowlist: "Allow for this session" skips future prompts for the same
  // normalized command string. Owned here (not a global singleton) so each chat session
  // resets on mount and cannot leak across sessions (Phase 01, plan 02).
  const sessionAllowRef = useRef(new Set<string>());
  // MCP write approval session allowlist — keyed by full `mcp__<server>__<tool>` (Phase 02, D-15).
  // Separate from bash allowlist because MCP tools are named, not normalized shell strings.
  const sessionMcpAllowRef = useRef(new Set<string>());

  const transport = useMemo(() => {
    // BYOK: inference + tool schema merge run in-process; MCP execution stays in onToolCall below.
    if (isLocalMode()) {
      return new LocalChatTransport<Message>({
        resolveModel: resolveChatModel,
        getMcpManager,
        buildSystemPrompt,
      });
    }

    return new DefaultChatTransport<Message>({
      api: apiClient.chat.$url().toString(),
      headers() {
        const auth = getAuth();
        return auth ? { Authorization: `Bearer ${auth.token}` } : new Headers();
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
        }
      }
    });
  }, [sessionId]);

  const chat = useAiChat<Message>({
    id: sessionId,
    messages: initialMessages,
    transport,
    async onToolCall({ toolCall }) {
      // Tool-continuation assistant messages may omit metadata — scan backward like transport.
      const mode =
        chat.messages.findLast((message) => message.metadata?.mode)?.metadata?.mode ??
        Mode.BUILD;

      const isMcpCall = looksLikeMcpToolName(toolCall.toolName);
      // AI SDK marks tools without static execute as `dynamic`. MCP tools are dynamic but must
      // still run on the CLI — only skip unrelated dynamic tools we do not own.
      if (toolCall.dynamic && !isMcpCall) return;

      if (isMcpCall) {
        // dynamicTool MCP entries are not in ChatTools union — widen addToolOutput for MCP path.
        const addMcpToolOutput = chat.addToolOutput as (params: {
          toolCallId: string;
          state?: "output-available" | "output-error";
          output?: unknown;
          errorText?: string;
        }) => void;

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

      try {
        // ── Phase 01 bash approval gate (HARNESS-03) ────────────────────────────
        if (toolCall.toolName === "bash" && mode === Mode.BUILD) {
          const { command } = toolInputSchemas.bash.parse(toolCall.input);
          if (requiresApproval(command, sessionAllowRef.current)) {
            const verdict = await requestBashApproval(dialog, command);
            if (verdict === "reject") {
              chat.addToolOutput({
                tool: "bash",
                toolCallId: toolCall.toolCallId,
                state: "output-error",
                errorText: BASH_REJECT_ERROR_TEXT,
              });
              return;
            }
            if (verdict === "allow-session") {
              rememberSessionAllow(sessionAllowRef.current, command);
            }
          }
        }

        const output = await executeLocalTool(toolCall.toolName, toolCall.input, mode);
        chat.addToolOutput({
          tool: toolCall.toolName as keyof ChatTools,
          toolCallId: toolCall.toolCallId,
          output,
        });
      } catch (error) {
        chat.addToolOutput({
          tool: toolCall.toolName as keyof ChatTools,
          toolCallId: toolCall.toolCallId,
          state: "output-error",
          errorText: error instanceof Error ? error.message : String(error),
        });
      }
    },
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  useEffect(() => {
    if (!isLocalMode()) return;
    if (chat.status !== "ready") return;

    try {
      updateLocalSession(sessionId, chat.messages);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("Local session not found:")
      ) {
        return;
      }
      console.error("Failed to persist local session", { sessionId, error });
    }
  }, [sessionId, chat.messages, chat.status]);

  useEffect(() => {
    if (!chat.error || !isLocalMode()) return;

    const pruned = stripIncompleteAssistantMessages(chat.messages);
    if (pruned.length === chat.messages.length) return;

    chat.setMessages(pruned);
  }, [chat.error, chat.status, chat.messages, chat.setMessages]);

  const submit = useCallback(
    (params: { userText: string; mode: ModeType; model: SupportedChatModelId }) => {
      return chat.sendMessage({
        text: params.userText,
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
    error: chat.error,
    submit,
    abort: chat.stop,
    interrupt: chat.stop,
  };
};