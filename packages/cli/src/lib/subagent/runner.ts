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
  SUPPORTED_CHAT_MODELS,
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
import { buildSubagentToolSet } from "./tool-set";
import { buildSubagentSystemPrompt, getGitSummary } from "./prompts";
import { runSubagentSaaSTurn } from "../subagent-stream-transport";
import type {
  ExecuteTaskToolParams,
  RunSubagentDeps,
  RunSubagentParams,
  RunSubagentResult,
} from "./types";

const INTERRUPTED_SUMMARY = "Interrupted by user";

type ToolExecuteContext = {
  mode: ModeType;
  sessionId?: string;
  sessionAllowRef: Set<string>;
  sessionMcpAllowRef: Set<string>;
  sessionWriteAllowRef: Set<string>;
  deps: RunSubagentDeps;
  hooksConfig: ReturnType<typeof loadMergedHooksConfig>;
};

function resolveSubagentModel(modelId?: string) {
  const id = (modelId ?? SUPPORTED_CHAT_MODELS[0]?.id) as string;
  try {
    return resolveChatModel(id);
  } catch {
    return {
      model: { modelId: id } as unknown as LanguageModel,
      provider: "openai" as const,
      modelId: id,
      providerOptions: undefined,
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

function wrapToolsWithExecute(baseTools: ToolSet, ctx: ToolExecuteContext): ToolSet {
  const wrapped: ToolSet = {};
  const dialog = ctx.deps.dialog;

  for (const [toolName, definition] of Object.entries(baseTools)) {
    const { description, inputSchema } = readToolDefinition(definition);
    wrapped[toolName] = tool({
      description: description ?? toolName,
      inputSchema: (inputSchema ?? toolInputSchemas.readFile) as never,
      execute: async (input, { toolCallId }) => {
        const isMcpCall = looksLikeMcpToolName(toolName);

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
              return { allowed: false, reason: hookResult.reason };
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
          throw new Error(pipelineResult.reason ?? "Tool execution blocked");
        }

        return capturedOutput;
      },
    });
  }

  return wrapped;
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

  const sessionAllowRef = new Set<string>();
  const sessionMcpAllowRef = new Set<string>();
  const sessionWriteAllowRef = new Set<string>();

  let hooksConfig: ReturnType<typeof loadMergedHooksConfig>;
  try {
    hooksConfig = loadMergedHooksConfig(cwd);
  } catch {
    hooksConfig = { hooks: [] };
  }

  const tools = wrapToolsWithExecute(baseTools, {
    mode: params.mode,
    sessionId: params.sessionId,
    sessionAllowRef,
    sessionMcpAllowRef,
    sessionWriteAllowRef,
    deps,
    hooksConfig,
  });

  const system = buildSubagentSystemPrompt({
    type: params.subagent_type,
    cwd,
    mode: params.mode,
    model: params.model,
    gitSummary,
  });

  const resolved = resolveSubagentModel(params.model);

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

    return { summary: result.text };
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
  const baseTools = buildSubagentToolSet(params.subagent_type, { mcpTools });

  const sessionAllowRef = new Set<string>();
  const sessionMcpAllowRef = new Set<string>();
  const sessionWriteAllowRef = new Set<string>();

  let hooksConfig: ReturnType<typeof loadMergedHooksConfig>;
  try {
    hooksConfig = loadMergedHooksConfig(cwd);
  } catch {
    hooksConfig = { hooks: [] };
  }

  const tools = wrapToolsWithExecute(baseTools, {
    mode: params.mode,
    sessionId: params.sessionId,
    sessionAllowRef,
    sessionMcpAllowRef,
    sessionWriteAllowRef,
    deps,
    hooksConfig,
  });

  const system = buildSubagentSystemPrompt({
    type: params.subagent_type,
    cwd,
    mode: params.mode,
    model: params.model,
    gitSummary,
  });

  const modelId = (params.model ?? SUPPORTED_CHAT_MODELS[0]?.id) as string;
  let messages: UIMessage[] = [
    {
      id: `subagent-user-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text: params.prompt }],
      metadata: { mode: params.mode, model: modelId },
    },
  ];

  let lastSummary = "";
  let steps = 0;

  while (steps < 25) {
    if (params.abortSignal?.aborted) {
      return { summary: lastSummary || INTERRUPTED_SUMMARY, interrupted: true };
    }

    steps += 1;
    const turn = await runSubagentSaaSTurn({
      sessionId: params.sessionId,
      messages,
      mode: params.mode,
      model: modelId,
      mcpTools,
      system,
      tools,
      abortSignal: params.abortSignal,
    });

    messages = turn.messages;
    lastSummary = turn.text;

    if (turn.done) {
      if (params.abortSignal?.aborted) {
        return { summary: lastSummary || INTERRUPTED_SUMMARY, interrupted: true };
      }
      return { summary: lastSummary };
    }
  }

  return { summary: lastSummary || "Subagent step limit reached" };
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
