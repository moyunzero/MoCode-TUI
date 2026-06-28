/**
 * Zod validation for ~/.mocode/mcp.json and project .mocode/mcp.json (Phase 02, HARNESS-04).
 */
import { z } from "zod";

const mcpToolOverrideSchema = z.object({
  readOnly: z.boolean(),
});

const mcpServerStdioSchema = z.object({
  enabled: z.boolean().default(true),
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().positive().default(60000),
  tools: z.record(z.string(), mcpToolOverrideSchema).optional(),
});

const mcpUrlSchema = z.string().refine((value) => {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}, "Invalid MCP server URL");

const mcpServerHttpSchema = z.object({
  enabled: z.boolean().default(true),
  transport: z.literal("http"),
  url: mcpUrlSchema,
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().positive().default(60000),
  tools: z.record(z.string(), mcpToolOverrideSchema).optional(),
});

const mcpServerSseSchema = z.object({
  enabled: z.boolean().default(true),
  transport: z.literal("sse"),
  url: mcpUrlSchema,
  headers: z.record(z.string(), z.string()).optional(),
  timeoutMs: z.number().positive().default(60000),
  tools: z.record(z.string(), mcpToolOverrideSchema).optional(),
});

export const mcpServerEntrySchema = z.discriminatedUnion("transport", [
  mcpServerStdioSchema,
  mcpServerHttpSchema,
  mcpServerSseSchema,
]);

export const mcpConfigSchema = z.object({
  mcpServers: z.record(z.string(), mcpServerEntrySchema),
});

export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpServerEntry = z.infer<typeof mcpServerEntrySchema>;
