/**
 * MCP tool schema deserialization for server-side streamText merge (Phase 02, D-06).
 *
 * Lives in @mocode/shared so packages/server can rebuild dynamicTool records without
 * importing packages/cli or @modelcontextprotocol/sdk.
 *
 * Intentionally duplicates `jsonSchemaToInputSchema` from packages/cli/src/mcp/tools.ts —
 * shared package must stay MCP-SDK-free. Both sides produce schema-only dynamicTool entries;
 * execution always happens on the CLI.
 */
import { dynamicTool, jsonSchema } from "ai";
import { z } from "zod";
import type { ToolSet } from "ai";

export type SerializedMcpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

function jsonSchemaToInputSchema(schema: unknown) {
  if (schema && typeof schema === "object") {
    try {
      return jsonSchema(schema as Record<string, unknown>);
    } catch {
      // Fall through to permissive Zod object.
    }
  }
  return z.object({}).passthrough();
}

/** Converts CLI wire-format MCP tools to AI SDK dynamicTool records without execute fn. */
export function deserializeMcpToolsToDynamic(mcpTools?: SerializedMcpTool[]): ToolSet {
  if (!mcpTools?.length) {
    return {};
  }

  const result: ToolSet = {};

  for (const tool of mcpTools) {
    result[tool.name] = dynamicTool({
      description: tool.description ?? tool.name,
      inputSchema: jsonSchemaToInputSchema(tool.inputSchema),
    });
  }

  return result;
}
