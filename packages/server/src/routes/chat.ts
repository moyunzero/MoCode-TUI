/**
 * Chat HTTP routes: submit a user turn and stream the assistant reply via SSE.
 *
 * Phase 8 extends the stream with:
 * - Multi-step agent loop via `streamText({ tools, stopWhen: stepCountIs(50) })`
 * - Reasoning, tool-call, and tool-result SSE events (mirrored in Message.parts)
 * - System prompt and cwd-scoped tools when session.cwd is set
 *
 * Phase 9 scopes every session lookup by `userId` from `requireAuth`, so users
 * can only chat in sessions they own.
 *
 * Phase 10 bills usage after each assistant message (complete or interrupted):
 * - `requireCreditsBalance` gates POST submit/resume when Polar balance <= 0
 * - `onFinish` captures token usage → credits via {@link calculateCreditsForUsage}
 * - {@link ingestAiUsage} reports to Polar with idempotent `chat-message:{id}` keys
 *
 * Phase 11 moves tool *execution* to the CLI:
 * - Server registers {@link getToolContracts} with `streamText` (definitions only)
 * - Client runs tools locally and re-posts via `addToolOutput` + auto-resubmit
 * - Session is not persisted until all tool calls in the response have output
 *   ({@link hasPendingToolCalls} gate in `onFinish`)
 *
 * Phase 02 MCP (D-06):
 * - CLI sends `mcpTools` JSON schemas in submit body (from McpManager.getToolDefinitions)
 * - Server merges via {@link deserializeMcpToolsToDynamic} — no MCP SDK on server
 * - MCP tool calls execute only in CLI `executeMcpToolCall`
 *
 * Persists USER / ASSISTANT rows to the database. Interrupted streams save partial
 * ASSISTANT content. Resume replays generation when the last stored message is USER-only.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  convertToModelMessages,
  streamText, 
  validateUIMessages,
  type InferUITools,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { db } from "@mocode/database/client";
import { 
  getToolContracts, 
  modeSchema,
  deserializeMcpToolsToDynamic,
  type ModeType, 
  type ToolContracts
} from "@mocode/shared";
import { buildSystemPrompt } from "../system-prompt";
import type { AuthenticatedEnv } from "../middleware/require-auth";
import { requireCreditsBalance } from "../middleware/require-credits-balance";
import {
  getActiveStreamResponse,
  clearActiveStream,
  registerStreamBuffer,
} from "../lib/active-stream-registry";
import { StreamReplayBuffer } from "../lib/stream-buffer";
import { isSupportedChatModel, resolveChatModel } from "../lib/model";
import {
  normalizeInterruptedMessages,
  stripIncompleteAssistantMessages,
} from "../lib/stream-interrupt";
import { shouldPersistOnFinish } from "../lib/chat-abort";
import { resolveSubagentChatFinish } from "../lib/chat-subagent";

type ChatMessageMetadata = {
  mode?: ModeType;
  model?: string;
  durationMs?: number;
  usage?: LanguageModelUsage;
};

type MocodeUIMessage = UIMessage<ChatMessageMetadata, never, InferUITools<ToolContracts>>;

/** Wire payload for one MCP tool schema — mirrors CLI SerializedMcpTool (no execute fn). */
const mcpToolSchema = z.object({
  name: z.string().regex(/^mcp__[^_].+__.+$/, "Invalid MCP tool name"),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
});

const submitSchema = z.object({
  id: z.string(),
  messages: z
    .array(
      z.custom<MocodeUIMessage>((value) => {
        return value != null && typeof value === "object" && "id" in value && "parts" in value;
      }),
    )
    .min(1),
  mode: modeSchema,
  model: z.string().refine(isSupportedChatModel, "Unsupported model"),
  mcpTools: z.array(mcpToolSchema).optional(),
  /** When false, inner subagent stream skips session message merge/persist (D-17). */
  persist: z.boolean().optional().default(true),
});

const submitValidator = zValidator("json", submitSchema, (result, c) => {
  if (!result.success) {
    return c.json({ error: "Invalid request body" }, 400);
  }
});

/** True when the assistant message still has tool calls awaiting client-side execution. */
function hasPendingToolCalls(message: MocodeUIMessage) {
  return message.parts.some((part) => {
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const state = (part as { state?: string }).state;
      return state !== "output-available" && state !== "output-error";
    }

    return false;
  });
}

function errorLogMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
};

const app = new Hono<AuthenticatedEnv>()
  .post(
    "/",
    requireCreditsBalance,
    submitValidator,
    async (c) => {
      const userId = c.get("userId");
      const { id, messages, mode, model, mcpTools, persist = true } = c.req.valid("json");

      try {
      const session = await db.session.findUnique({
        where: { id, userId },
      });

      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }

      const startTime = Date.now();
      // Tool contracts only — executors live in CLI (Phase 11). MCP schemas merged from CLI wire payload (D-06).
      const tools = {
        ...getToolContracts(mode),
        ...deserializeMcpToolsToDynamic(mcpTools),
      };
      const resolvedModel = resolveChatModel(model);
      const mergedMessages: MocodeUIMessage[] = persist
        ? (() => {
            const previousMessages = Array.isArray(session.messages)
              ? (session.messages as unknown as MocodeUIMessage[])
              : [];
            const next = [...previousMessages];

            for (const message of messages) {
              const incomingMessage = {
                ...message,
                metadata: { ...message.metadata, mode, model },
              } satisfies MocodeUIMessage;

              const existingMessageIndex = next.findIndex((m) => m.id === incomingMessage.id);

              if (existingMessageIndex === -1) {
                next.push(incomingMessage);
              } else {
                next[existingMessageIndex] = incomingMessage;
              }
            }

            return next;
          })()
        : messages.map(
            (message) =>
              ({
                ...message,
                metadata: { ...message.metadata, mode, model },
              }) satisfies MocodeUIMessage,
          );

      const nextMessages = await validateUIMessages<MocodeUIMessage>({
        messages: stripIncompleteAssistantMessages(mergedMessages),
        tools,
      });
      const modelMessages = await convertToModelMessages(nextMessages, { tools });
      let completedUsage: LanguageModelUsage | null = null;
      const replayBuffer = new StreamReplayBuffer();

      const result = streamText({
        model: resolvedModel.model,
        system: buildSystemPrompt({ mode }),
        messages: modelMessages,
        tools,
        providerOptions: resolvedModel.providerOptions,
        onFinish(event) {
          completedUsage = event.totalUsage;
        },
      });

      return result.toUIMessageStreamResponse<MocodeUIMessage>({
        originalMessages: nextMessages,
        messageMetadata({ part }) {
          if (part.type === "start") {
            return { mode, model };
          }

          if (part.type !== "finish") return undefined;

          return {
            mode,
            model,
            durationMs: Date.now() - startTime,
            ...(completedUsage ? { usage: completedUsage } : {}),
          };
        },
        consumeSseStream: ({ stream }) => {
          registerStreamBuffer(id, userId, replayBuffer);
          replayBuffer.ingest(stream.pipeThrough(new TextEncoderStream()));
        },
        async onFinish(event) {
          try {
          let messagesToPersist = event.messages;

          if (event.isAborted) {
            clearActiveStream(id, replayBuffer);
            messagesToPersist = normalizeInterruptedMessages(event.messages);
          }

          if (persist) {
            if (
              !shouldPersistOnFinish({
                isAborted: event.isAborted,
                messagesToPersist,
                responseMessage: event.responseMessage,
                hasPendingToolCalls: (message) =>
                  hasPendingToolCalls(message as MocodeUIMessage),
              })
            ) {
              return;
            }

            await resolveSubagentChatFinish({
              persist: true,
              sessionId: id,
              userId,
              messages: messagesToPersist,
              responseMessageId: event.responseMessage.id,
              completedUsage,
              model,
              db,
            });
          } else {
            await resolveSubagentChatFinish({
              persist: false,
              sessionId: id,
              userId,
              messages: messagesToPersist,
              responseMessageId: event.responseMessage.id,
              completedUsage,
              model,
              db,
            });
          }

          clearActiveStream(id, replayBuffer);
          } catch (error) {
            clearActiveStream(id, replayBuffer);
            console.error("Failed to persist chat finish", {
              message: errorLogMessage(error),
              sessionId: id,
            });
          }
        },
        onError(error) {
          clearActiveStream(id, replayBuffer);
          return error instanceof Error ? error.message : String(error);
        },
      });
      } catch (error) {
        clearActiveStream(id);
        const message = error instanceof Error ? error.message : "Chat request failed";
        console.error("Chat handler failed before stream", {
          sessionId: id,
          message: errorLogMessage(error),
        });
        return c.json({ error: message }, 502);
      }
    },
  )
  .get("/:id/stream", requireCreditsBalance, async (c) => {
    const userId = c.get("userId");
    const id = c.req.param("id");

    const session = await db.session.findUnique({
      where: { id, userId },
    });

    if (!session) {
      return c.body(null, 404);
    }

    return getActiveStreamResponse(id, userId);
  });

export default app;