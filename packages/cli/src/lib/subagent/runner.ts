/**
 * Subagent runner — BYOK generateText loop and SaaS ephemeral stream (Phase 04, D-03–D-20).
 */
import {
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
} from "ai";
import {
  DEFAULT_CHAT_MODEL_ID,
  toolInputSchemas,
  type ModeType,
  type SerializedMcpTool,
} from "@mocode/shared";
import { executeLocalTool } from "../local-tools";
import { resolveChatModel } from "../local-model";
import { isLocalMode } from "../local-mode";
import { runToolPipeline } from "../tool-pipeline";
import { loadMergedHooksConfig } from "../hooks/loader";
import { runMatchingHooks, type HookPayload } from "../hooks/runner";
import { requiresApproval, rememberSessionAllow } from "../bash-approval";
import { requestBashApproval } from "../bash-approval-ui";
import {
  requiresLocalWriteApproval,
  LOCAL_WRITE_REJECT_ERROR_TEXT,
} from "../local-write-approval";
import { requestLocalWriteApproval } from "../local-write-approval-ui";
import { executeMcpToolCall } from "../mcp-tool-call";
import { requestMcpApproval } from "../mcp-approval-ui";
import { getMcpManager } from "../../mcp/manager";
import { looksLikeMcpToolName } from "../../mcp/heuristics";
import { consumeSubagentStream, postSubagentChatStream } from "../subagent-stream-transport";
import { buildSubagentToolSet } from "./tool-set";
import { buildSubagentSystemPrompt, getGitSummary } from "./prompts";
import type {
  ExecuteTaskToolParams,
  RunSubagentDeps,
  RunSubagentParams,
  RunSubagentResult,
} from "./types";

const INTERRUPTED_SUMMARY = "Interrupted by user";

function buildPromptFallbackSummary(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return "Subagent finished without a text summary.";
  }
  return `Task completed: ${trimmed}`;
}

function finalizeSubagentSummary(summary: string, promptFallback?: string): string {
  const trimmed = summary.trim();
  return trimmed || promptFallback || "Subagent finished without a text summary.";
}

type ToolExecuteContext = {
  mode: ModeType;
  sessionId?: string;
  sessionAllowRef: Set<string>;
  sessionMcpAllowRef: Set<string>;
  sessionWriteAllowRef: Set<string>;
  deps: RunSubagentDeps;
  hooksConfig: ReturnType<typeof loadMergedHooksConfig>;
};

function createSubagentSessionState(cwd: string): Pick<
  ToolExecuteContext,
  "sessionAllowRef" | "sessionMcpAllowRef" | "sessionWriteAllowRef" | "hooksConfig"
> {
  const sessionAllowRef = new Set<string>();
  const sessionMcpAllowRef = new Set<string>();
  const sessionWriteAllowRef = new Set<string>();

  let hooksConfig: ReturnType<typeof loadMergedHooksConfig>;
  try {
    hooksConfig = loadMergedHooksConfig(cwd);
  } catch {
    hooksConfig = { hooks: [] };
  }

  return {
    sessionAllowRef,
    sessionMcpAllowRef,
    sessionWriteAllowRef,
    hooksConfig,
  };
}

function resolveSubagentModel(
  modelId?: string,
):
  | {
      ok: true;
      model: LanguageModel;
      providerOptions: ReturnType<typeof resolveChatModel>["providerOptions"];
    }
  | {
      ok: false;
      error: string;
    } {
  const id = modelId ?? DEFAULT_CHAT_MODEL_ID;
  try {
    const resolved = resolveChatModel(id);
    return {
      ok: true,
      model: resolved.model,
      providerOptions: resolved.providerOptions,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readToolDefinition(definition: unknown): {
  description?: string;
  inputSchema?: unknown;
} {
  if (definition && typeof definition === "object") {
    const record = definition as { description?: string; inputSchema?: unknown };
    return {
      description: record.description,
      inputSchema: record.inputSchema,
    };
  }
  return {};
}

type ExecuteToolCallParams = {
  toolName: string;
  toolCallId: string;
  input: unknown;
  ctx: ToolExecuteContext;
};

async function executeSubagentToolCall({
  toolName,
  toolCallId,
  input,
  ctx,
}: ExecuteToolCallParams): Promise<{ output?: unknown; error?: string }> {
  const isMcpCall = looksLikeMcpToolName(toolName);
  const dialog = ctx.deps.dialog;

  const makeHookPayload = (event: HookPayload["event"]): HookPayload => ({
    toolName,
    input,
    sessionId: ctx.sessionId ?? "subagent",
    mode: ctx.mode,
    cwd: ctx.deps.cwd ?? process.cwd(),
    event,
  });

  let capturedOutput: unknown;
  const pipelineResult = await runToolPipeline({
    toolCall: { toolName, toolCallId, input },
    beforeHook: async () => {
      const hookResult = await runMatchingHooks(
        "beforeToolCall",
        toolName,
        makeHookPayload("beforeToolCall"),
        ctx.hooksConfig.hooks,
      );
      if (hookResult && !hookResult.allowed) {
        return {
          allowed: false,
          reason: hookResult.reason,
          hookId: hookResult.hookId,
          hookTimedOut: hookResult.timedOut,
        };
      }
      return { allowed: true };
    },
    approvalGate: async () => {
      if (isMcpCall) {
        return { approved: true };
      }

      if (toolName === "bash" && ctx.mode === "BUILD" && dialog) {
        const { command } = toolInputSchemas.bash.parse(input);
        if (requiresApproval(command, ctx.sessionAllowRef)) {
          const verdict = await requestBashApproval(dialog, command);
          if (verdict === "reject") {
            return { approved: false, reason: "User rejected bash command" };
          }
          if (verdict === "allow-session") {
            rememberSessionAllow(ctx.sessionAllowRef, command);
          }
        }
      }

      if (
        dialog &&
        requiresLocalWriteApproval(toolName, ctx.mode, ctx.sessionWriteAllowRef)
      ) {
        const verdict = await requestLocalWriteApproval(dialog, toolName, input);
        if (verdict === "reject") {
          return { approved: false, reason: LOCAL_WRITE_REJECT_ERROR_TEXT };
        }
        if (verdict === "allow-session") {
          ctx.sessionWriteAllowRef.add(toolName);
        }
      }

      return { approved: true };
    },
    executeTool: async () => {
      if (isMcpCall) {
        if (!dialog) {
          throw new Error("MCP tools require dialog context");
        }
        let mcpOutput: unknown;
        let mcpError: string | undefined;
        await executeMcpToolCall(
          { toolName, toolCallId, input },
          {
            getMcpManager: ctx.deps.getMcpManager ?? getMcpManager,
            requestMcpApproval,
            sessionMcpAllowRef: ctx.sessionMcpAllowRef,
            mode: ctx.mode,
            dialog,
            addToolOutput: (params) => {
              if (params.state === "output-error") {
                mcpError = params.errorText ?? "MCP tool call failed";
                return;
              }
              mcpOutput = params.output;
            },
          },
        );
        if (mcpError) {
          throw new Error(mcpError);
        }
        capturedOutput = mcpOutput;
        return;
      }

      capturedOutput = await executeLocalTool(toolName, input, ctx.mode);
    },
    afterHook: async () => {
      await runMatchingHooks(
        "afterToolCall",
        toolName,
        makeHookPayload("afterToolCall"),
        ctx.hooksConfig.hooks,
      );
    },
  });

  if (pipelineResult.blocked) {
    return { error: pipelineResult.reason ?? "Tool execution blocked" };
  }

  return { output: capturedOutput };
}

function wrapToolsWithExecute(baseTools: ToolSet, ctx: ToolExecuteContext): ToolSet {
  const wrapped: ToolSet = {};

  for (const [toolName, definition] of Object.entries(baseTools)) {
    const { description, inputSchema } = readToolDefinition(definition);
    wrapped[toolName] = tool({
      description: description ?? toolName,
      inputSchema: (inputSchema ?? toolInputSchemas.readFile) as never,
      execute: async (input, { toolCallId }) => {
        const result = await executeSubagentToolCall({
          toolName,
          toolCallId,
          input,
          ctx,
        });
        if (result.error) {
          throw new Error(result.error);
        }
        return result.output;
      },
    });
  }

  return wrapped;
}

type PendingToolCall = {
  toolName: string;
  toolCallId: string;
  input: unknown;
};

function extractPendingToolCalls(message: UIMessage): PendingToolCall[] {
  if (!Array.isArray(message.parts)) {
    return [];
  }
  const calls: PendingToolCall[] = [];
  for (const part of message.parts) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as {
      type?: string;
      state?: string;
      toolCallId?: string;
      input?: unknown;
      toolName?: string;
    };
    if (candidate.state === "output-available" || candidate.state === "output-error") {
      continue;
    }
    if (typeof candidate.toolCallId !== "string") {
      continue;
    }
    if (candidate.type === "dynamic-tool" && typeof candidate.toolName === "string") {
      calls.push({
        toolName: candidate.toolName,
        toolCallId: candidate.toolCallId,
        input: candidate.input,
      });
      continue;
    }
    if (typeof candidate.type === "string" && candidate.type.startsWith("tool-")) {
      calls.push({
        toolName: candidate.type.slice(5),
        toolCallId: candidate.toolCallId,
        input: candidate.input,
      });
    }
  }
  return calls;
}

function patchAssistantWithToolResult(
  assistant: UIMessage,
  toolCallId: string,
  result: { output?: unknown; error?: string },
): UIMessage {
  if (!Array.isArray(assistant.parts)) {
    return assistant;
  }
  const parts = assistant.parts.map((part) => {
    if (!part || typeof part !== "object") return part;
    const candidate = part as { toolCallId?: string; type?: string };
    if (
      candidate.type !== "dynamic-tool" &&
      !(typeof candidate.type === "string" && candidate.type.startsWith("tool-"))
    ) {
      return part;
    }
    if (candidate.toolCallId !== toolCallId) return part;
    if (result.error) {
      return { ...part, state: "output-error", errorText: result.error } as typeof part;
    }
    return { ...part, state: "output-available", output: result.output } as typeof part;
  });
  return { ...assistant, parts };
}

function extractAssistantSummary(message: UIMessage): string {
  if (!Array.isArray(message.parts)) {
    return "";
  }
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        Boolean(part && typeof part === "object" && (part as { type?: string }).type === "text"),
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function extractToolOutputSummary(message: UIMessage): string {
  if (!Array.isArray(message.parts)) {
    return "";
  }
  for (const part of message.parts) {
    if (!part || typeof part !== "object") continue;
    const candidate = part as {
      type?: string;
      state?: string;
      output?: unknown;
      errorText?: string;
    };
    if (
      candidate.type !== "dynamic-tool" &&
      !(typeof candidate.type === "string" && candidate.type.startsWith("tool-"))
    ) {
      continue;
    }
    if (candidate.state !== "output-available" && candidate.state !== "output-error") {
      continue;
    }
    if (candidate.state === "output-error" && typeof candidate.errorText === "string") {
      const text = candidate.errorText.trim();
      if (text.length > 0) return text;
      continue;
    }
    if (candidate.output == null) continue;
    if (typeof candidate.output === "string") {
      const text = candidate.output.trim();
      if (text.length > 0) return text;
      continue;
    }
    try {
      const json = JSON.stringify(candidate.output);
      if (json && json !== "{}" && json !== "[]") {
        return json;
      }
    } catch {
      // best-effort summary fallback
    }
  }
  return "";
}

async function buildSaaSExploreFallbackSummary(
  params: RunSubagentParams,
): Promise<string | null> {
  if (params.subagent_type !== "explore") {
    return null;
  }

  const summarize = (output: unknown, label: string): string | null => {
    if (!output || typeof output !== "object") return null;
    const entries = (output as { entries?: Array<{ name?: string; type?: string }> }).entries;
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const names = entries
      .filter((entry) => entry?.type === "directory" && typeof entry.name === "string")
      .map((entry) => entry.name as string)
      .slice(0, 12);
    if (names.length === 0) return null;
    return `${label}: ${names.join(", ")}`;
  };

  try {
    const packagesOutput = await executeLocalTool("listDirectory", { path: "packages" }, params.mode);
    const packagesSummary = summarize(packagesOutput, "packages directories");
    if (packagesSummary) {
      return packagesSummary;
    }
  } catch {
    // best effort
  }

  try {
    const rootOutput = await executeLocalTool("listDirectory", { path: "." }, params.mode);
    const rootSummary = summarize(rootOutput, "project directories");
    if (rootSummary) {
      return rootSummary;
    }
  } catch {
    // best effort
  }

  return null;
}

function loadMcpToolsForSubagent(
  subagentType: RunSubagentParams["subagent_type"],
  mode: ModeType,
  deps: RunSubagentDeps,
): SerializedMcpTool[] {
  if (subagentType !== "explore") {
    return [];
  }

  try {
    const manager = deps.getMcpManager?.() ?? getMcpManager();
    return manager.getToolDefinitions(mode);
  } catch {
    return [];
  }
}

async function runSubagentByok(
  params: RunSubagentParams,
  deps: RunSubagentDeps,
): Promise<RunSubagentResult> {
  const cwd = deps.cwd ?? process.cwd();
  const gitSummary = await getGitSummary(cwd);
  const mcpTools = loadMcpToolsForSubagent(params.subagent_type, params.mode, deps);
  const baseTools = buildSubagentToolSet(params.subagent_type, { mcpTools });

  const sessionState = createSubagentSessionState(cwd);

  const tools = wrapToolsWithExecute(baseTools, {
    mode: params.mode,
    sessionId: params.sessionId,
    ...sessionState,
    deps,
  });

  const system = buildSubagentSystemPrompt({
    type: params.subagent_type,
    cwd,
    mode: params.mode,
    model: params.model,
    gitSummary,
  });

  const resolved = resolveSubagentModel(params.model);
  if (!resolved.ok) {
    return {
      summary: resolved.error,
      error: true,
    };
  }

  try {
    const result = await generateText({
      model: resolved.model,
      system,
      messages: [{ role: "user", content: params.prompt }],
      tools,
      stopWhen: stepCountIs(25),
      abortSignal: params.abortSignal,
      providerOptions: resolved.providerOptions,
    });

    if (params.abortSignal?.aborted) {
      return {
        summary: result.text || INTERRUPTED_SUMMARY,
        interrupted: true,
      };
    }

    return {
      summary: finalizeSubagentSummary(
        result.text,
        buildPromptFallbackSummary(params.prompt),
      ),
    };
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return { summary: INTERRUPTED_SUMMARY, interrupted: true };
    }
    return {
      summary: error instanceof Error ? error.message : String(error),
      error: true,
    };
  }
}

async function runSubagentSaaS(
  params: RunSubagentParams,
  deps: RunSubagentDeps,
): Promise<RunSubagentResult> {
  if (!params.sessionId) {
    return { summary: "Missing sessionId for SaaS subagent", error: true };
  }
  const cwd = deps.cwd ?? process.cwd();
  const gitSummary = await getGitSummary(cwd);
  const mcpTools = loadMcpToolsForSubagent(params.subagent_type, params.mode, deps);

  const sessionState = createSubagentSessionState(cwd);

  const toolContext: ToolExecuteContext = {
    mode: params.mode,
    sessionId: params.sessionId,
    deps,
    ...sessionState,
  };

  const modelId = params.model ?? DEFAULT_CHAT_MODEL_ID;
  const subagentSystem = buildSubagentSystemPrompt({
    type: params.subagent_type,
    cwd,
    mode: params.mode,
    model: params.model,
    gitSummary,
  });
  const seededPrompt = `${subagentSystem}\n\n# User task\n${params.prompt}`;
  const seedUserMessage: UIMessage = {
    id: `subagent-user-${Date.now()}`,
    role: "user",
    parts: [{ type: "text", text: seededPrompt }],
    metadata: { mode: params.mode, model: modelId },
  };

  let messages: UIMessage[] = [seedUserMessage];
  let lastNonEmptySummary = "";
  let lastToolOutputSummary = "";

  try {
    for (let step = 0; step < 25; step += 1) {
      if (params.abortSignal?.aborted) {
        return { summary: INTERRUPTED_SUMMARY, interrupted: true };
      }

      const response = await postSubagentChatStream(
        { sessionId: params.sessionId },
        { messages, mode: params.mode, model: modelId, mcpTools },
        params.abortSignal,
      );
      const assistant = await consumeSubagentStream(
        response,
        {
          id: `subagent-assistant-${Date.now()}`,
          role: "assistant",
          parts: [],
          metadata: { mode: params.mode, model: modelId },
        },
      );
      messages = [...messages, assistant];
      const assistantSummary = extractAssistantSummary(assistant);
      if (assistantSummary.length > 0) {
        lastNonEmptySummary = assistantSummary;
      }
      const toolOutputSummary = extractToolOutputSummary(assistant);
      if (toolOutputSummary.length > 0) {
        lastToolOutputSummary = toolOutputSummary;
      }

      const pendingCalls = extractPendingToolCalls(assistant);
      if (pendingCalls.length === 0) {
        const exploreFallback = await buildSaaSExploreFallbackSummary(params);
        return {
          summary: finalizeSubagentSummary(
            assistantSummary.length > 0
              ? assistantSummary
              : lastNonEmptySummary ||
                  lastToolOutputSummary ||
                  exploreFallback ||
                  buildPromptFallbackSummary(params.prompt),
          ),
        };
      }

      let patchedAssistant = assistant;
      for (const call of pendingCalls) {
        const toolResult = await executeSubagentToolCall({
          toolName: call.toolName,
          toolCallId: call.toolCallId,
          input: call.input,
          ctx: toolContext,
        });
        patchedAssistant = patchAssistantWithToolResult(
          patchedAssistant,
          call.toolCallId,
          toolResult,
        );
      }
      messages[messages.length - 1] = patchedAssistant;
    }
    if (lastNonEmptySummary.length > 0) {
      return { summary: lastNonEmptySummary };
    }
    if (lastToolOutputSummary.length > 0) {
      return { summary: lastToolOutputSummary };
    }
    const exploreFallback = await buildSaaSExploreFallbackSummary(params);
    if (exploreFallback) {
      return { summary: exploreFallback };
    }
    return { summary: buildPromptFallbackSummary(params.prompt) };
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return { summary: INTERRUPTED_SUMMARY, interrupted: true };
    }
    return {
      summary: error instanceof Error ? error.message : String(error),
      error: true,
    };
  }
}

/** Runs an isolated subagent and returns summary-only output (D-03, D-12, D-17). */
export async function runSubagent(
  params: RunSubagentParams,
  deps: RunSubagentDeps = {},
): Promise<RunSubagentResult> {
  if (params.abortSignal?.aborted) {
    return { summary: INTERRUPTED_SUMMARY, interrupted: true };
  }

  try {
    if (params.sessionId && !isLocalMode()) {
      return await runSubagentSaaS(params, deps);
    }
    return await runSubagentByok(params, deps);
  } catch (error) {
    if (params.abortSignal?.aborted) {
      return { summary: INTERRUPTED_SUMMARY, interrupted: true };
    }
    return {
      summary: error instanceof Error ? error.message : String(error),
      error: true,
    };
  }
}

/** Shared Task tool handler — parses schema and delegates to {@link runSubagent}. */
export async function executeTaskTool({
  input,
  mode,
  model,
  sessionId,
  abortSignal,
  deps = {},
}: ExecuteTaskToolParams): Promise<RunSubagentResult> {
  const parsed = toolInputSchemas.task.parse(input);
  return runSubagent(
    {
      subagent_type: parsed.subagent_type,
      prompt: parsed.prompt,
      description: parsed.description,
      mode,
      model,
      sessionId,
      abortSignal,
    },
    deps,
  );
}
