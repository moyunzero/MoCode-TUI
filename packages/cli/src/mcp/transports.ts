/**
 * MCP transport factory — stdio, HTTP (Streamable), and SSE (Phase 02, D-02).
 *
 * Stdio uses `stderr: "ignore"` so child process banner logs (e.g. npx MCP servers)
 * do not paint through the OpenTUI dialog layer.
 */
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpTransport, type McpServerConfig, type McpTransportType } from "./types";

export type TaggedTransport = Transport & { type: McpTransportType };

function tagTransport(transport: Transport, type: McpTransportType): TaggedTransport {
  return Object.assign(transport, { type });
}

/** Creates an MCP client transport for the given server config entry. */
export function createTransport(entry: McpServerConfig): TaggedTransport {
  switch (entry.transport) {
    case McpTransport.STDIO:
      return tagTransport(
        new StdioClientTransport({
          command: entry.command,
          args: entry.args ?? [],
          env: { ...process.env, ...entry.env } as Record<string, string>,
          stderr: "ignore",
        }),
        McpTransport.STDIO,
      );
    case McpTransport.HTTP:
      return tagTransport(
        new StreamableHTTPClientTransport(new URL(entry.url), {
          requestInit: entry.headers ? { headers: entry.headers } : undefined,
        }),
        McpTransport.HTTP,
      );
    case McpTransport.SSE:
      return tagTransport(
        new SSEClientTransport(new URL(entry.url), {
          requestInit: entry.headers ? { headers: entry.headers } : undefined,
        }),
        McpTransport.SSE,
      );
    default: {
      const _exhaustive: never = entry;
      throw new Error(`Unsupported MCP transport: ${(_exhaustive as McpServerConfig).transport}`);
    }
  }
}
