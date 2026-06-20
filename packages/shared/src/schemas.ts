import { z } from "zod";

/**
 * Shared wire + persistence schemas for the agent streaming protocol (Phase 8).
 *
 * Server validates tool args and message parts before DB write; CLI validates
 * incoming SSE frames with {@link chatStreamEventSchema}.
 */

/** Opaque JSON object passed to tool calls during streaming. */
export const toolCallArgsSchema = z.record(z.string(), z.json());

/**
 * Persisted structure for a message's streamed segments (stored in Message.parts).
 *
 * Order matches arrival during generation. Tool results are inlined on the
 * tool-call part after execution completes.
 */
export const messagePartSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("reasoning"),
        text: z.string(),
    }),
    z.object({
        type: z.literal("tool-call"),
        id: z.string(),
        name: z.string(),
        args: toolCallArgsSchema,
        result: z.string().optional(),
    }),
    z.object({
        type: z.literal("text"),
        text: z.string(),
    }),
]);

export const messagePartsSchema = z.array(messagePartSchema);

export type MessagePart = z.infer<typeof messagePartSchema>;

/** Wire format for SSE chunks from POST /chat and /chat/:id/resume. */
export const chatStreamEventSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("text-delta"),
        text: z.string(),
    }),
    /** Provider reasoning/thinking tokens; rendered in BotMessage "Thinking:" block. */
    z.object({
        type: z.literal("reasoning-delta"),
        text: z.string(),
    }),
    /** Emitted when the model invokes a tool; paired with tool-result by toolCallId. */
    z.object({
        type: z.literal("tool-call"),
        toolCallId: z.string(),
        toolName: z.string(),
        args: toolCallArgsSchema,
    }),
    /** Tool execution output; client marks the matching tool-call as done. */
    z.object({
        type: z.literal("tool-result"),
        toolCallId: z.string(),
        result: z.string(),
    }),
    z.object({
        type:z.literal("done"),
        messageId: z.string(),
        durationMs: z.number(),
    }),
    z.object({
        type: z.literal("error"),
        message: z.string(),
    }),
]);

export type ChatStreamEvent = z.infer<typeof chatStreamEventSchema>;