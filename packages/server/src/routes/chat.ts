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
import type { Prisma } from "@mocode/database";
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
import { calculateCreditsForUsage } from "../lib/credits";
import { ingestAiUsage } from "../lib/polar";
import { isSupportedChatModel, resolveChatModel } from "../lib/model";

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
};

const app = new Hono<AuthenticatedEnv>()
  .post(
    "/",
    requireCreditsBalance,
    submitValidator,
    async (c) => {
      const userId = c.get("userId");
      const { id, messages, mode, model, mcpTools } = c.req.valid("json");

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
      const previousMessages = Array.isArray(session.messages)
        ? (session.messages as unknown as MocodeUIMessage[])
        : [];
      const mergedMessages = [...previousMessages];
      
      for (const message of messages) {
        const incomingMessage = {
          ...message,
          metadata: { ...message.metadata, mode, model },
        } satisfies MocodeUIMessage;

        const existingMessageIndex = mergedMessages.findIndex((m) => m.id === incomingMessage.id);

        if (existingMessageIndex === -1) {
          mergedMessages.push(incomingMessage);
        } else {
          mergedMessages[existingMessageIndex] = incomingMessage;
        }
      }

      const nextMessages = await validateUIMessages<MocodeUIMessage>({
        messages: mergedMessages,
        tools,
      });
      const modelMessages = await convertToModelMessages(nextMessages, { tools });
      let completedUsage: LanguageModelUsage | null = null;

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
        async onFinish(event) {
          if (event.isAborted) return;

          // Wait for the CLI to finish all tool calls before persisting/billing.
          if (hasPendingToolCalls(event.responseMessage)) return;

          await db.session.update({
            where: { id, userId },
            data: {
              messages: event.messages as unknown as Prisma.InputJsonValue,
            },
          });

          if (!completedUsage) return;

          try {
            const billableUsage = calculateCreditsForUsage({
              provider: resolvedModel.provider,
              model: resolvedModel.modelId,
              usage: completedUsage,
            });

            await ingestAiUsage({
              externalCustomerId: userId,
              eventId: `chat-message:${event.responseMessage.id}`,
              credits: billableUsage.credits,
            });
          } catch (error) {
            console.error("Failed to ingest Polar AI usage for chat message", {
              error,
              sessionId: id,
              messageId: event.responseMessage.id,
              userId,
            });
          }
        },
        onError(error) {
          return error instanceof Error ? error.message : String(error);
        },
      });
    },
  );

export default app;