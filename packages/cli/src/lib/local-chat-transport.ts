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
import { Mode, type ModeType, type SupportedChatModelId } from "@mocode/shared";
import { loadMergedMcpConfig } from "../mcp/config";
import type { McpManager } from "../mcp/manager";
import {
  buildMergedToolSet,
  buildMcpDynamicToolsFromManager,
} from "../mcp/tools";
import { isMcpToolName } from "../mcp/heuristics";
import type { ResolvedModel } from "./local-model";
import { formatChatStreamError } from "./stream-error";
import { hasVisibleAssistantContent } from "@mocode/shared";

type LocalChatMetadata = {
  mode?: ModeType;
  model?: SupportedChatModelId | string;
  durationMs?: number;
  usage?: LanguageModelUsage;
};

function readMetadata(message: UIMessage): LocalChatMetadata | undefined {
  return message.metadata as LocalChatMetadata | undefined;
}

function findLastMetadataValue<K extends keyof LocalChatMetadata>(
  messages: UIMessage[],
  key: K,
): LocalChatMetadata[K] | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const value = readMetadata(messages[i]!)?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

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

/** Drops assistant rows with no user-visible content (empty or step-start-only placeholders). */
export function stripIncompleteAssistantMessages<UI_MESSAGE extends UIMessage>(
  messages: UI_MESSAGE[],
): UI_MESSAGE[] {
  return messages.filter(
    (message) => message.role !== "assistant" || hasVisibleAssistantContent(message),
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
    skills?: Array<{ name: string; description: string }>;
  }) => string;
  onFinish?: (event: LocalChatTransportFinishEvent<UI_MESSAGE>) => Promise<void>;
  cwd?: string;
};

/**
 * In-process transport for BYOK `--local` sessions.
 * Implements AI SDK `ChatTransport` so `useChat` can share the same hook for SaaS and local.
 */
export class LocalChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  private activeStream: {
    chatId: string | undefined;
    stream: ReadableStream<UIMessageChunk>;
  } | null = null;

  constructor(private readonly opts: LocalChatTransportOptions<UI_MESSAGE>) {}

  /**
   * Runs one model turn locally: merge tools, build system prompt, stream assistant UI chunks.
   * MCP tools have no `execute` fn here — the client handles them in `onToolCall`.
   */
  async sendMessages({
    messages,
    abortSignal,
    chatId,
  }: Parameters<ChatTransport<UI_MESSAGE>["sendMessages"]>[0]): Promise<
    ReadableStream<UIMessageChunk>
  > {
    const mode = findLastMetadataValue(messages, "mode") ?? Mode.BUILD;
    const modelId = findLastMetadataValue(messages, "model");

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
    const mcpToolNames = Object.keys(tools).filter(isMcpToolName);
    const mcpRequested = isMcpUserRequest(lastUserText(messages));
    const systemPrompt = this.opts.buildSystemPrompt({ mode, mcpToolNames, mcpRequested });
    const resolvedModel = this.opts.resolveModel(modelId);
    const startTime = Date.now();
    let completedUsage: LanguageModelUsage | null = null;

    const messagesForValidation = stripIncompleteAssistantMessages(messages);
    const nextMessages = await validateUIMessages<UI_MESSAGE>({
      messages: messagesForValidation,
      tools: tools as Parameters<typeof validateUIMessages<UI_MESSAGE>>[0]["tools"],
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
    const self = this;

    const rawStream = result.toUIMessageStream<UI_MESSAGE>({
      originalMessages: nextMessages,
      onError: formatChatStreamError,
      messageMetadata({ part }) {
        if (part.type === "start") {
          return { mode, model: modelId } as never;
        }

        if (part.type !== "finish") return undefined;

        return {
          mode,
          model: modelId,
          durationMs: Date.now() - startTime,
          ...(completedUsage ? { usage: completedUsage } : {}),
        } as never;
      },
      async onFinish(event) {
        if (self.activeStream?.stream === stream) self.activeStream = null;
        if (!onFinish) return;
        await onFinish({
          messages: event.messages,
          usage: completedUsage ?? undefined,
        });
      },
    });

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        const reader = rawStream.getReader();
        void (async () => {
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) {
                if (self.activeStream?.stream === stream) self.activeStream = null;
                controller.close();
                return;
              }
              controller.enqueue(value);
            }
          } catch (error) {
            if (self.activeStream?.stream === stream) self.activeStream = null;
            controller.error(error);
          }
        })();
      },
      cancel(reason) {
        if (self.activeStream?.stream === stream) self.activeStream = null;
        return rawStream.cancel(reason);
      },
    });

    this.activeStream = { chatId, stream };

    abortSignal?.addEventListener(
      "abort",
      () => {
        if (this.activeStream?.stream === stream) this.activeStream = null;
      },
      { once: true },
    );

    return stream;
  }

  /**
   * Returns the in-process stream while generation is still running (HARNESS-07 BYOK).
   */
  async reconnectToStream({
    chatId,
  }: {
    chatId: string;
  }): Promise<ReadableStream<UIMessageChunk> | null> {
    if (!this.activeStream || this.activeStream.chatId !== chatId) return null;
    return this.activeStream.stream;
  }
}
