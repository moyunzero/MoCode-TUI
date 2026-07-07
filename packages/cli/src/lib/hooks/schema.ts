/**
 * Zod validation for ~/.mocode/hooks.json and project .mocode/hooks.json (Phase 04, D-33).
 */
import { z } from "zod";

export const hookEventSchema = z.enum(["beforeToolCall", "afterToolCall"]);

export const hookEntrySchema = z.object({
  id: z.string().min(1),
  event: hookEventSchema,
  toolName: z.string().min(1),
  command: z.array(z.string()).min(1),
  timeoutMs: z.number().positive().default(30000),
});

export const hooksConfigSchema = z
  .object({
    hooks: z.array(hookEntrySchema).default([]),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const hook of config.hooks) {
      if (seen.has(hook.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate hook id "${hook.id}" within a single hooks.json`,
        });
      }
      seen.add(hook.id);
    }
  });

export type HookEvent = z.infer<typeof hookEventSchema>;
export type HookEntry = z.infer<typeof hookEntrySchema>;
export type HooksConfig = z.infer<typeof hooksConfigSchema>;
