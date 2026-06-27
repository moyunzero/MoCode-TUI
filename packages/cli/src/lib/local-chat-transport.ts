/**
 * BYOK in-process ChatTransport (D-06).
 *
 * Mirrors packages/server/src/routes/chat.ts `streamText` loop locally with
 * merged builtin + MCP tools. No HTTP to MoCode server when `--local` is active.
 *
 * Pipeline per `sendMessages`:
 * 1. Resolve mode/model from message metadata
 * 2. Build tool set: builtin contracts + MCP dynamicTool (schemas only, no execute)
 * 3. Detect MCP intent in last user turn → `mcpRequested` strengthens system prompt
 * 4. validateUIMessages → convertToModelMessages → streamText → toUIMessageStream
 *
 * Tool execution still happens in `use-chat` `onToolCall` (Phase 11 model).
 */
import {
  convertToModelMessages,
  streamText,
  validateUIMessages,
  type ChatTransport,
  type LanguageModelUsage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { Mode, type ModeType } from "@mocode/shared";
import { loadMergedMcpConfig } from "../mcp/config";
import type { McpManager } from "../mcp/manager";
import {
  buildMergedToolSet,
  buildMcpDynamicToolsFromManager,
} from "../mcp/tools";
import { isMcpToolName } from "../mcp/heuristics";
import type { ResolvedModel } from "./local-model";

/** Last user-visible text in the outgoing batch — used for MCP routing heuristics. */
function lastUserText(messages: UIMessage[]): string {
  const message = messages.findLast((entry) => entry.role === "user");
  if (!message?.parts) return "";
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join(" ");
}

/**
 * True when the user explicitly asks for MCP this turn (word "mcp" or a full tool name).
 * Drives `buildSystemPrompt({ mcpRequested })` so the model prioritizes `mcp__*` tools
 * over grep/glob on the first tool-call step.
 */
function isMcpUserRequest(text: string): boolean {
  return /\bmcp\b/i.test(text) || /\bmcp__[\w-]+__[\w-]+/i.test(text);
}

/** Drops assistant placeholders left behind when a stream fails before any parts arrive. */
export function stripIncompleteAssistantMessages<UI_MESSAGE extends UIMessage>(
  messages: UI_MESSAGE[],
): UI_MESSAGE[] {
  return messages.filter(
    (message) =>
      message.role !== "assistant" ||
      (Array.isArray(message.parts) && message.parts.length > 0),
  );
}

export type LocalChatTransportFinishEvent<UI_MESSAGE extends UIMessage> = {
  messages: UI_MESSAGE[];
  usage?: LanguageModelUsage;
};

export type LocalChatTransportOptions<UI_MESSAGE extends UIMessage> = {
  resolveModel: (modelId: string) => ResolvedModel;
  getMcpManager: () => McpManager;
  buildSystemPrompt: (params: {
    mode: ModeType;
    mcpToolNames?: string[];
    mcpRequested?: boolean;
  }) => string;
  onFinish?: (event: LocalChatTransportFinishEvent<UI_MESSAGE>) => Promise<void>;
  cwd?: string;
};

/**
 * In-process transport for BYOK `--local` sessions.
 * Implements AI SDK `ChatTransport` so `useChat` can share the same hook for SaaS and local.
 */
export class LocalChatTransport<UI_MESSAGE extends UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  constructor(private readonly opts: LocalChatTransportOptions<UI_MESSAGE>) {}

  /**
   * Runs one model turn locally: merge tools, build system prompt, stream assistant UI chunks.
   * MCP tools have no `execute` fn here — the client handles them in `onToolCall`.
   */
  async sendMessages({
    messages,
    abortSignal,
  }: Parameters<ChatTransport<UI_MESSAGE>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const mode =
      messages.findLast((message) => message.metadata?.mode)?.metadata?.mode ??
      Mode.BUILD;
    const modelId = messages.findLast((message) => message.metadata?.model)?.metadata
      ?.model;

    if (!modelId || typeof modelId !== "string") {
      throw new Error("Missing model in message metadata");
    }

    const cwd = this.opts.cwd ?? process.cwd();
    const config = loadMergedMcpConfig(cwd);
    const mcpDynamicTools = buildMcpDynamicToolsFromManager(
      this.opts.getMcpManager(),
      config,
    );
    const tools = buildMergedToolSet(mode, mcpDynamicTools, config);
    const mcpToolNames = Object.keys(mcpDynamicTools).filter(isMcpToolName);
    const mcpRequested = isMcpUserRequest(lastUserText(messages));
    const systemPrompt = this.opts.buildSystemPrompt({ mode, mcpToolNames, mcpRequested });
    const resolvedModel = this.opts.resolveModel(modelId);
    const startTime = Date.now();
    let completedUsage: LanguageModelUsage | null = null;

    const messagesForValidation = stripIncompleteAssistantMessages(messages);
    const nextMessages = await validateUIMessages<UI_MESSAGE>({
      messages: messagesForValidation,
      tools,
    });
    const modelMessages = await convertToModelMessages(nextMessages, { tools });

    const result = streamText({
      model: resolvedModel.model,
      system: systemPrompt,
      messages: modelMessages,
      tools,
      providerOptions: resolvedModel.providerOptions,
      abortSignal,
      onFinish(event) {
        completedUsage = event.totalUsage;
      },
    });

    const onFinish = this.opts.onFinish;

    return result.toUIMessageStream<UI_MESSAGE>({
      originalMessages: nextMessages,
      messageMetadata({ part }) {
        if (part.type === "start") {
          return { mode, model: modelId };
        }

        if (part.type !== "finish") return undefined;

        return {
          mode,
          model: modelId,
          durationMs: Date.now() - startTime,
          ...(completedUsage ? { usage: completedUsage } : {}),
        };
      },
      async onFinish(event) {
        if (!onFinish) return;
        await onFinish({
          messages: event.messages,
          usage: completedUsage ?? undefined,
        });
      },
    });
  }

  /**
   * Stream resume is Phase 3 (HARNESS-07). BYOK returns null like the initial stub.
   */
  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return null;
  }
}
