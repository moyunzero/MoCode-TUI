/**
 * MCP connection manager — connect, reconnect, tool calls (Phase 02, D-14, D-16).
 *
 * Owns the lifecycle of every MCP server declared in merged `mcp.json` (global +
 * project). The CLI is the sole MCP client: servers never run on MoCode server.
 *
 * Architecture:
 * - `connectAll` / `connectServer` — stdio child processes or HTTP/SSE transports
 * - `getRegisteredTools` — tool schemas fed to the model (stable across brief disconnects)
 * - `callTool` — invoked from `executeMcpToolCall` after optional TUI write approval
 * - `getMcpManager` — process singleton; SIGINT/SIGTERM disconnects all servers
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ModeType } from "@mocode/shared";
import { getEnabledServers, loadMergedMcpConfig } from "./config";
import type { McpServerEntry } from "./config-schema";
import { createTransport } from "./transports";
import { getMcpToolDefinitions } from "./tools";
import type { SerializedMcpTool } from "./tools";
import {
  McpConnectionStatus,
  McpTransport,
  type McpConnectionStatusType,
  type McpServerConfig,
  type McpTransportType,
} from "./types";

const CLIENT_NAME = "mocode";
const CLIENT_VERSION = "1.0.0";
const DEFAULT_TIMEOUT_MS = 60_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_ATTEMPTS = 5;

/** Row shape for `/mcp` dialog and status polling. */
export type McpServerStatus = {
  name: string;
  transport: McpTransportType;
  status: McpConnectionStatusType;
  enabled: boolean;
  error?: string;
  toolCount?: number;
};

/** `listTools` result grouped by configured server name. */
export type DiscoveredMcpTool = {
  serverName: string;
  tools: Tool[];
};

type ManagedServer = {
  client: Client | null;
  config: McpServerEntry;
  status: McpConnectionStatusType;
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  error?: string;
  tools: Tool[];
};

/** Injectable deps for unit tests (timers, transport factory, config loader). */
export type McpManagerDeps = {
  loadConfig?: typeof loadMergedMcpConfig;
  createClient?: () => Client;
  createTransportFn?: (entry: McpServerConfig) => ReturnType<typeof createTransport>;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(authorization|api-key|x-api-key):\s*\S+/gi, "$1: [REDACTED]");
}

function toMcpServerConfig(entry: McpServerEntry): McpServerConfig {
  return entry as McpServerConfig;
}

let exitHandlersRegistered = false;
let managerInstance: McpManager | null = null;

function registerExitHandlers(manager: McpManager): void {
  if (exitHandlersRegistered) {
    return;
  }
  exitHandlersRegistered = true;

  const cleanup = () => {
    void manager.disconnectAll();
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

export class McpManager {
  private readonly servers = new Map<string, ManagedServer>();
  /** Prevents duplicate in-flight `connectServer` for the same name (e.g. rapid `/mcp` toggles). */
  private readonly connecting = new Map<string, Promise<void>>();
  private cwd = process.cwd();
  private readonly loadConfig: typeof loadMergedMcpConfig;
  private readonly createClient: () => Client;
  private readonly createTransportFn: (entry: McpServerConfig) => ReturnType<typeof createTransport>;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(deps: McpManagerDeps = {}) {
    this.loadConfig = deps.loadConfig ?? loadMergedMcpConfig;
    this.createClient = deps.createClient ?? (() => new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }));
    this.createTransportFn = deps.createTransportFn ?? createTransport;
    this.setTimer = deps.setTimer ?? setTimeout;
    this.clearTimer = deps.clearTimer ?? clearTimeout;
  }

  /** Loads merged config and connects all enabled MCP servers. */
  async connectAll(cwd: string): Promise<void> {
    this.cwd = cwd;
    const config = this.loadConfig(cwd);
    const enabled = getEnabledServers(config);

    await Promise.all(
      Object.entries(enabled).map(([name, serverConfig]) => this.connectServer(name, serverConfig)),
    );
  }

  /** Connects or disconnects a single server after its enabled flag changed in config. */
  async applyServerEnabledChange(serverName: string, enabled: boolean, cwd: string): Promise<void> {
    this.cwd = cwd;

    if (!enabled) {
      await this.disconnect(serverName);
      const entry = this.servers.get(serverName);
      if (entry) {
        entry.status = McpConnectionStatus.DISABLED;
      }
      return;
    }

    const config = this.loadConfig(cwd);
    const serverConfig = config.mcpServers[serverName];
    if (!serverConfig) {
      throw new Error(`MCP server "${serverName}" not found in config`);
    }

    await this.connectServer(serverName, serverConfig);
  }

  /** Returns connection status for every server in merged config. */
  getStatus(): McpServerStatus[] {
    const config = this.loadConfig(this.cwd);
    return Object.entries(config.mcpServers).map(([name, serverConfig]) => {
      const state = this.servers.get(name);
      const disabled = serverConfig.enabled === false;
      const connected = state?.status === McpConnectionStatus.CONNECTED;

      return {
        name,
        transport: serverConfig.transport,
        status: disabled
          ? McpConnectionStatus.DISABLED
          : (state?.status ?? McpConnectionStatus.PENDING),
        enabled: !disabled,
        error: disabled ? undefined : state?.error,
        toolCount: connected ? state.tools.length : undefined,
      };
    });
  }

  /**
   * Disconnects one MCP server and clears its reconnect timer.
   * Intentionally does not clear `entry.tools` — last-known schemas stay available
   * for `getRegisteredTools` until the next successful `listTools`.
   */
  async disconnect(serverName: string): Promise<void> {
    const entry = this.servers.get(serverName);
    if (!entry) {
      return;
    }

    if (entry.reconnectTimer) {
      this.clearTimer(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }

    if (entry.client) {
      await entry.client.close().catch(() => {});
      entry.client = null;
    }

    entry.status = McpConnectionStatus.PENDING;
  }

  /** Disconnects all MCP servers. */
  async disconnectAll(): Promise<void> {
    await Promise.all([...this.servers.keys()].map((name) => this.disconnect(name)));
  }

  /**
   * Invokes a tool on a connected MCP server with per-server timeout (D-16).
   * Calls `ensureConnected` first so a briefly disconnected but enabled server
   * can be brought back before the tool loop retries the same call.
   */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    options?: { timeout?: number },
  ) {
    await this.ensureConnected(serverName);

    const entry = this.servers.get(serverName);
    if (!entry?.client || entry.status !== McpConnectionStatus.CONNECTED) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    const timeout = options?.timeout ?? entry.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return entry.client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout, resetTimeoutOnProgress: true },
    );
  }

  /** On-demand reconnect when `callTool` runs while the transport is down but server is enabled. */
  private async ensureConnected(serverName: string): Promise<void> {
    const entry = this.servers.get(serverName);
    if (entry?.client && entry.status === McpConnectionStatus.CONNECTED) {
      return;
    }

    const config = this.loadConfig(this.cwd);
    const serverConfig = config.mcpServers[serverName];
    if (!serverConfig || serverConfig.enabled === false) {
      return;
    }

    await this.connectServer(serverName, serverConfig);
  }

  /** Resets reconnect attempts and retries connection once (for /mcp manual reconnect). */
  async reconnect(serverName: string): Promise<void> {
    const entry = this.servers.get(serverName);
    if (!entry) {
      return;
    }

    if (entry.reconnectTimer) {
      this.clearTimer(entry.reconnectTimer);
      entry.reconnectTimer = undefined;
    }

    entry.reconnectAttempts = 0;
    await this.connectServer(serverName, entry.config);
  }

  /** Only connected servers — use `getRegisteredTools` when the model needs schemas. */
  getDiscoveredTools(): DiscoveredMcpTool[] {
    const discovered: DiscoveredMcpTool[] = [];

    for (const [serverName, entry] of this.servers) {
      if (entry.status === McpConnectionStatus.CONNECTED && entry.tools.length > 0) {
        discovered.push({ serverName, tools: entry.tools });
      }
    }

    return discovered;
  }

  /**
   * Tool schemas for model registration — uses live connection when available,
   * otherwise last-known schemas for enabled servers (keeps tool-loop turns stable).
   */
  getRegisteredTools(): DiscoveredMcpTool[] {
    const config = this.loadConfig(this.cwd);
    const registered: DiscoveredMcpTool[] = [];

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      if (serverConfig.enabled === false) {
        continue;
      }

      const entry = this.servers.get(serverName);
      const liveTools =
        entry?.status === McpConnectionStatus.CONNECTED && entry.tools.length > 0
          ? entry.tools
          : entry?.tools.length
            ? entry.tools
            : undefined;

      if (liveTools && liveTools.length > 0) {
        registered.push({ serverName, tools: liveTools });
      }
    }

    return registered;
  }

  /** Mode-filtered MCP tool schemas for SaaS/BYOK registration (schemas only, no execution). */
  getToolDefinitions(mode: ModeType): SerializedMcpTool[] {
    return getMcpToolDefinitions(this, mode, this.cwd);
  }

  /**
   * Connects one server: create SDK client → transport → listTools → cache schemas.
   *
   * Reconnect policy (D-14):
   * - HTTP/SSE: `scheduleReconnect` with exponential backoff on failure
   * - stdio: no auto-reconnect — child exit is usually config/user action; user retries via `/mcp`
   *
   * On disconnect, `entry.tools` is retained (see `disconnect`) so `getRegisteredTools`
   * can still expose schemas while status is pending/failed.
   */
  private async connectServer(name: string, config: McpServerEntry): Promise<void> {
    const inFlight = this.connecting.get(name);
    if (inFlight) {
      await inFlight;
      return;
    }

    const promise = this.connectServerOnce(name, config);
    this.connecting.set(name, promise);
    try {
      await promise;
    } finally {
      if (this.connecting.get(name) === promise) {
        this.connecting.delete(name);
      }
    }
  }

  private async connectServerOnce(name: string, config: McpServerEntry): Promise<void> {
    const previous = this.servers.get(name);
    if (previous?.reconnectTimer) {
      this.clearTimer(previous.reconnectTimer);
    }
    if (previous?.client) {
      await previous.client.close().catch(() => {});
    }

    const entry: ManagedServer = {
      client: null,
      config,
      status: McpConnectionStatus.PENDING,
      reconnectAttempts: previous?.reconnectAttempts ?? 0,
      tools: previous?.tools ?? [],
    };
    this.servers.set(name, entry);

    try {
      const client = this.createClient();
      const transport = this.createTransportFn(toMcpServerConfig(config));
      await client.connect(transport);

      let tools: Tool[] = [];
      try {
        ({ tools } = await client.listTools());
      } catch (discoveryError) {
        await client.close().catch(() => {});
        entry.status = McpConnectionStatus.FAILED;
        entry.error = sanitizeErrorMessage(discoveryError);

        const isRemoteTransport =
          config.transport === McpTransport.HTTP || config.transport === McpTransport.SSE;
        if (isRemoteTransport) {
          this.scheduleReconnect(name);
        }
        return;
      }

      entry.client = client;
      entry.status = McpConnectionStatus.CONNECTED;
      entry.reconnectAttempts = 0;
      entry.error = undefined;
      entry.tools = tools;
    } catch (error) {
      entry.status = McpConnectionStatus.FAILED;
      entry.error = sanitizeErrorMessage(error);

      const isRemoteTransport =
        config.transport === McpTransport.HTTP || config.transport === McpTransport.SSE;

      if (isRemoteTransport) {
        this.scheduleReconnect(name);
      }
    }
  }

  /**
   * Exponential backoff reconnect for remote transports only.
   * Sets status to PENDING during the wait so `/mcp` can show "pending…".
   */
  private scheduleReconnect(serverName: string): void {
    const entry = this.servers.get(serverName);
    if (!entry) {
      return;
    }

    if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      entry.status = McpConnectionStatus.FAILED;
      return;
    }

    entry.reconnectAttempts += 1;
    entry.status = McpConnectionStatus.PENDING;
    const delay = INITIAL_RECONNECT_DELAY_MS * 2 ** (entry.reconnectAttempts - 1);

    entry.reconnectTimer = this.setTimer(() => {
      entry.reconnectTimer = undefined;
      void this.connectServer(serverName, entry.config);
    }, delay);
  }
}

/** Returns the process-wide MCP manager singleton. */
export function getMcpManager(): McpManager {
  if (!managerInstance) {
    managerInstance = new McpManager();
    registerExitHandlers(managerInstance);
  }
  return managerInstance;
}

/** Clears the singleton — for unit tests only. */
export function resetMcpManagerForTests(): void {
  managerInstance = null;
}
