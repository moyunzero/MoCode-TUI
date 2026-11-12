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
 * Failover: an attempt only counts as started once a *useful* UI chunk arrives
 * (not a bare `start`). A provider that rejects the connection — or emits
 * `start` then an `error` — therefore fails *before* anything is rendered, and
 * the next model in the chain is tried (see `lib/provider-chain.ts`).
 * Once a useful chunk has been emitted the turn is visible and is never replayed.
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
import { DEFAULT_COMPACTION_POLICY, compactMessages } from "@mocode/shared";
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
import { runWithFailover, type FailoverDecision } from "./provider-chain";
import { stallTimeoutMs } from "./chat-fetch";

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

/** Per-attempt budget covering connect + first useful chunk only. */


/** Chunks that prove the provider is actually producing a turn. */
const USEFUL_CHUNK_TYPES = new Set([
  "text-start",
  "text-delta",
  "reasoning-start",
  "reasoning-delta",
  "tool-input-start",
  "tool-input-delta",
  "tool-input-available",
  "tool-call",
  "finish",
  "finish-step",
]);

function isUsefulChunk(chunk: UIMessageChunk): boolean {
  return USEFUL_CHUNK_TYPES.has(chunk.type);
}

function isErrorChunk(chunk: UIMessageChunk): boolean {
  return chunk.type === "error";
}

function errorChunkMessage(chunk: UIMessageChunk): string {
  if ("errorText" in chunk && typeof chunk.errorText === "string" && chunk.errorText.length > 0) {
    return chunk.errorText;
  }
  return "upstream provider error";
}

/** Shape `classifyFailover` treats as a retryable timeout. */
function attemptTimeoutError(): Error {
  const error = new Error("attempt timed out before useful output");
  error.name = "TimeoutError";
  return error;
}

/** Shape `classifyFailover` treats as a non-retryable user abort. */
function userAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Read until a useful chunk confirms success, an `error` chunk fails the
 * attempt, the stream ends, the per-attempt deadline expires, or the user aborts.
 * Leading non-useful chunks (e.g. `start`) are buffered and returned with the reader.
 */
async function readUntilAttemptSettled(
  reader: {
    read: () => Promise<{ done: boolean; value?: UIMessageChunk }>;
    cancel: (reason?: unknown) => Promise<void>;
  },
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<{
  reader: {
    read: () => Promise<{ done: boolean; value?: UIMessageChunk }>;
    cancel: (reason?: unknown) => Promise<void>;
  };
  prefix: UIMessageChunk[];
  done: boolean;
}> {
  const prefix: UIMessageChunk[] = [];
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);

  const abortAttempt = () => {
    clearTimeout(timer);
    // Cancelling is what actually unblocks a pending `read()`. Without this the
    // deadline only sets a flag nobody observes and a silent provider hangs forever.
    void reader.cancel().catch(() => {});
  };

  const onAbort = () => abortAttempt();

  try {
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    deadline.signal.addEventListener("abort", onAbort, { once: true });

    while (true) {
      const { done, value } = await reader.read();

      // Check cancellation *before* interpreting the chunk: a read unblocked by our
      // own cancel, or a late error chunk after an abort, must not become a
      // retryable 502 that sends the turn to another provider.
      if (abortSignal?.aborted) throw userAbortError();
      if (deadline.signal.aborted) throw attemptTimeoutError();

      if (done || value === undefined) {
        clearTimeout(timer);
        return { reader, prefix, done: true };
      }

      if (isErrorChunk(value)) {
        abortAttempt();
        throw Object.assign(new Error(errorChunkMessage(value)), { statusCode: 502 });
      }

      prefix.push(value);

      if (isUsefulChunk(value)) {
        clearTimeout(timer);
        return { reader, prefix, done: false };
      }
    }
  } catch (error) {
    clearTimeout(timer);
    throw error;
  } finally {
    abortSignal?.removeEventListener("abort", onAbort);
    deadline.signal.removeEventListener("abort", onAbort);
  }
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
  /** Explicit opt-in to trying another provider; see `FailoverOptions.consent`. */
  allowFailover?: boolean;
  /** Attempts per model; defaults to `MOCODE_PROVIDER_RETRIES` or 3. */
  attemptsPerModel?: number;
  /** Injectable for tests so they do not wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Called when a fallback model answered — the caller must show this to the user. */
  onDowngrade?: (info: { from: string; to: string }) => void;
  /** Called for every failed attempt, for logging. */
  onAttemptFailed?: (event: { modelId: string; decision: FailoverDecision }) => void;
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

    const messagesForValidation = stripIncompleteAssistantMessages(messages);
    const nextMessages = await validateUIMessages<UI_MESSAGE>({
      messages: messagesForValidation,
      tools: tools as Parameters<typeof validateUIMessages<UI_MESSAGE>>[0]["tools"],
    });
    // Same policy as the server path: fold old turns out of the *model input* only,
    // so the client keeps its full transcript.
    const compaction = compactMessages(nextMessages, DEFAULT_COMPACTION_POLICY);
    const modelMessages = await convertToModelMessages(compaction.messages, { tools });

    const startTime = Date.now();
    const onFinish = this.opts.onFinish;
    // Bound to *this* send's stream so an older overlapping cleanup cannot clear a newer one.
    let ownedStream: ReadableStream<UIMessageChunk> | null = null;
    const clearActive = () => {
      if (
        this.activeStream?.chatId === chatId &&
        ownedStream !== null &&
        this.activeStream.stream === ownedStream
      ) {
        this.activeStream = null;
      }
    };

    /**
     * One attempt = create the stream and wait for useful output (or a decisive
     * error). Provider failures reject here, before any chunk is enqueued to the
     * caller, which is what makes a retry safe.
     */
    const outcome = await runWithFailover({
      primary: modelId,
      consent: this.opts.allowFailover === true,
      attemptsPerModel: this.opts.attemptsPerModel,
      sleep: this.opts.sleep,
      attempt: async (candidate) => {
        let completedUsage: LanguageModelUsage | null = null;
        const resolved = this.opts.resolveModel(candidate);

        const result = streamText({
          model: resolved.model,
          system: systemPrompt,
          messages: modelMessages,
          tools,
          providerOptions: resolved.providerOptions,
          abortSignal,
          onFinish(event) {
            completedUsage = event.totalUsage;
          },
        });

        const rawStream = result.toUIMessageStream<UI_MESSAGE>({
          originalMessages: nextMessages,
          onError: formatChatStreamError,
          messageMetadata({ part }) {
            if (part.type === "start") {
              return { mode, model: candidate } as never;
            }

            if (part.type !== "finish") return undefined;

            return {
              mode,
              model: candidate,
              durationMs: Date.now() - startTime,
              ...(completedUsage ? { usage: completedUsage } : {}),
            } as never;
          },
          async onFinish(event) {
            clearActive();
            if (!onFinish) return;
            await onFinish({
              messages: event.messages,
              usage: completedUsage ?? undefined,
            });
          },
        });

        const reader = rawStream.getReader();
        return readUntilAttemptSettled(
          reader as {
            read: () => Promise<{ done: boolean; value?: UIMessageChunk }>;
            cancel: (reason?: unknown) => Promise<void>;
          },
          abortSignal,
          stallTimeoutMs(),
        );
      },
      onAttemptFailed: this.opts.onAttemptFailed,
    });

    if (outcome.downgradedFrom) {
      this.opts.onDowngrade?.({ from: outcome.downgradedFrom, to: outcome.modelId });
    }

    const { reader, prefix, done } = outcome.value;

    const stream = new ReadableStream<UIMessageChunk>({
      start(controller) {
        for (const chunk of prefix) {
          controller.enqueue(chunk);
        }

        if (done) {
          clearActive();
          controller.close();
          return;
        }

        void (async () => {
          try {
            while (true) {
              const { done: finished, value } = await reader.read();
              if (finished) {
                clearActive();
                controller.close();
                return;
              }
              controller.enqueue(value);
            }
          } catch (error) {
            clearActive();
            controller.error(error);
          }
        })();
      },
      cancel(reason) {
        clearActive();
        return reader.cancel(reason);
      },
    });

    ownedStream = stream;
    // A finished attempt (empty or already drained) is not reconnectable.
    if (!done) {
      this.activeStream = { chatId, stream };
      abortSignal?.addEventListener("abort", clearActive, { once: true });
    }

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
