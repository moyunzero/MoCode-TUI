/**
 * MCP tools → AI SDK dynamicTool bridge (Phase 02, D-05, D-07, D-08).
 *
 * Responsibilities:
 * - Name tools `mcp__<server>__<tool>` (Claude Code convention, D-05)
 * - Build schema-only dynamicTool entries (no execute — CLI runs MCP in onToolCall)
 * - Filter write MCP tools in PLAN mode (D-08)
 * - Serialize schemas for SaaS wire payload (`getMcpToolDefinitions` → chat submit body)
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { getToolContracts, Mode, type ModeType } from "@mocode/shared";
import { dynamicTool, jsonSchema, type ToolSet } from "ai";
import { z } from "zod";
import type { McpConfig, McpServerEntry } from "./config-schema";
import { loadMergedMcpConfig } from "./config";
import {
  isMcpReadOnlyTool,
  isMcpToolName,
  parseMcpToolName,
  type McpToolConfigOverride,
} from "./heuristics";
import type { McpManager } from "./manager";

export type McpToolDescriptor = {
  serverName: string;
  tool: {
    name: string;
    description?: string;
    inputSchema?: unknown;
  };
};

export type SerializedMcpTool = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** Formats MCP tool name per D-05: `mcp__<server>__<tool>`. */
export function mcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

function toolConfigOverride(
  serverConfig: McpServerEntry | undefined,
  toolName: string,
): McpToolConfigOverride | undefined {
  return serverConfig?.tools?.[toolName];
}

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

/** Maps listTools results to AI SDK dynamicTool entries (no execute fn). */
export function mcpToolsToDynamicTools(
  serverName: string,
  tools: Array<Tool | McpToolDescriptor["tool"]>,
  serverConfig?: McpServerEntry,
): ToolSet {
  const result: ToolSet = {};

  for (const tool of tools) {
    const fullName = mcpToolName(serverName, tool.name);
    result[fullName] = dynamicTool({
      description: tool.description ?? `MCP tool ${tool.name} from ${serverName}`,
      inputSchema: jsonSchemaToInputSchema(tool.inputSchema),
    });
  }

  return result;
}

/** Removes write MCP tools from the tool set in PLAN mode (D-08). */
export function filterMcpToolsForMode(
  mode: ModeType,
  toolSet: ToolSet,
  config?: McpConfig,
): ToolSet {
  if (mode === Mode.BUILD) {
    return toolSet;
  }

  const filtered: ToolSet = {};
  for (const [name, definition] of Object.entries(toolSet)) {
    if (!isMcpToolName(name)) {
      filtered[name] = definition;
      continue;
    }

    const { server, tool } = parseMcpToolName(name);
    const override = toolConfigOverride(config?.mcpServers[server], tool);
    if (isMcpReadOnlyTool(tool, override)) {
      filtered[name] = definition;
    }
  }

  return filtered;
}

/** Builds MCP-only dynamicTool set from descriptors with mode filtering. */
export function buildMcpToolSet(
  mode: ModeType,
  descriptors: McpToolDescriptor[],
  config?: McpConfig,
): ToolSet {
  let combined: ToolSet = {};

  for (const { serverName, tool } of descriptors) {
    const serverConfig = config?.mcpServers[serverName];
    combined = { ...combined, ...mcpToolsToDynamicTools(serverName, [tool], serverConfig) };
  }

  return filterMcpToolsForMode(mode, combined, config);
}

/** Merges local tool contracts with mode-filtered MCP dynamic tools. */
export function buildMergedToolSet(
  mode: ModeType,
  mcpDynamicTools: ToolSet,
  config?: McpConfig,
): ToolSet {
  return {
    ...getToolContracts(mode),
    ...filterMcpToolsForMode(mode, mcpDynamicTools, config),
  };
}

/** JSON-safe wire format for SaaS chat request `mcpTools` payload. */
export function serializeMcpToolsForServer(toolSet: ToolSet): SerializedMcpTool[] {
  return Object.entries(toolSet)
    .filter(([name]) => isMcpToolName(name))
    .map(([name, definition]) => {
      const tool = definition as {
        description?: string;
        inputSchema?: unknown;
      };

      return {
        name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      };
    });
}

/** Builds dynamicTool map from all connected MCP servers. */
export function buildMcpDynamicToolsFromManager(
  manager: McpManager,
  config?: McpConfig,
): ToolSet {
  const mergedConfig = config ?? loadMergedMcpConfig(process.cwd());
  let combined: ToolSet = {};

  for (const { serverName, tools } of manager.getRegisteredTools()) {
    const serverConfig = mergedConfig.mcpServers[serverName];
    combined = {
      ...combined,
      ...mcpToolsToDynamicTools(serverName, tools, serverConfig),
    };
  }

  return combined;
}

/** Serialized MCP tool schemas for a session mode (schemas only, no execution). */
export function getMcpToolDefinitions(
  manager: McpManager,
  mode: ModeType,
  cwd = process.cwd(),
): SerializedMcpTool[] {
  const config = loadMergedMcpConfig(cwd);
  return serializeDiscoveredMcpTools(mode, manager.getRegisteredTools(), config);
}

/**
 * SaaS path: preserves raw MCP `inputSchema` from listTools for the server wire payload.
 * Prefer this over `serializeMcpToolsForServer` when schemas must round-trip unchanged.
 */
export function serializeDiscoveredMcpTools(
  mode: ModeType,
  discovered: ReturnType<McpManager["getDiscoveredTools"]>,
  config: McpConfig,
): SerializedMcpTool[] {
  const serialized: SerializedMcpTool[] = [];

  for (const { serverName, tools } of discovered) {
    const serverConfig = config.mcpServers[serverName];

    for (const tool of tools) {
      const override = toolConfigOverride(serverConfig, tool.name);
      if (mode === Mode.PLAN && !isMcpReadOnlyTool(tool.name, override)) {
        continue;
      }

      serialized.push({
        name: mcpToolName(serverName, tool.name),
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
    }
  }

  return serialized;
}
