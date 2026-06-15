import { z } from "zod";

/** Opaque JSON object passed to tool calls during streaming. */
export const toolCallArgsSchema = z.record(z.string(), z.json());

/** Persisted structure for a message's streamed segments (stored in Message.parts). */
export const messagePartSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("reasoning"),
        text: z.string(),
    }),
    z.object({
        type: z.literal("tool_call"),
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

/** Wire format for SSE chunks from the chat endpoint (future streaming integration). */
export const chatStreamEventSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("text-delta"),
        text: z.string(),
    }),
    z.object({
        type: z.literal("reasoning-delta"),
        text: z.string(),
    }),
    z.object({
        type: z.literal("tool-call"),
        toolCallId: z.string(),
        toolName: z.string(),
        args: toolCallArgsSchema,
    }),
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