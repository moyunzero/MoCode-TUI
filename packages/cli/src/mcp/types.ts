/**
 * MCP transport and connection types for MoCode CLI MCP client (Phase 02, D-02).
 */

export const McpTransport = {
  STDIO: "stdio",
  HTTP: "http",
  SSE: "sse",
} as const;

export type McpTransportType = (typeof McpTransport)[keyof typeof McpTransport];

export const McpConnectionStatus = {
  CONNECTED: "connected",
  PENDING: "pending",
  FAILED: "failed",
  DISABLED: "disabled",
} as const;

export type McpConnectionStatusType =
  (typeof McpConnectionStatus)[keyof typeof McpConnectionStatus];

export type McpToolOverride = {
  readOnly: boolean;
};

export type McpServerConfigStdio = {
  enabled: boolean;
  transport: typeof McpTransport.STDIO;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs: number;
  tools?: Record<string, McpToolOverride>;
};

export type McpServerConfigHttp = {
  enabled: boolean;
  transport: typeof McpTransport.HTTP;
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  tools?: Record<string, McpToolOverride>;
};

export type McpServerConfigSse = {
  enabled: boolean;
  transport: typeof McpTransport.SSE;
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  tools?: Record<string, McpToolOverride>;
};

export type McpServerConfig =
  | McpServerConfigStdio
  | McpServerConfigHttp
  | McpServerConfigSse;
