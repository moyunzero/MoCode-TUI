import { z } from "zod";
import { modeSchema, supportedChatModelIdSchema } from "@mocode/shared";
import type { Message } from "../hooks/use-chat";

export const sessionLocationSchema = z.object({
  session: z.custom<unknown>((val) => val != null && typeof val === "object" && "id" in val),
  initialPrompt: z
    .object({
      message: z.string(),
      mode: modeSchema,
      model: supportedChatModelIdSchema,
    })
    .optional(),
  local: z.boolean().optional(),
});

/** Coerce persisted session JSON into chat messages; empty when malformed. */
export function parseInitialMessages(raw: unknown): Message[] {
  return Array.isArray(raw) ? (raw as Message[]) : [];
}
