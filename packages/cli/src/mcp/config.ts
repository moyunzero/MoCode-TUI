/**
 * MCP config loader — union merge of global and project mcp.json (Phase 02, D-01).
 *
 * Merge rule: project `mcpServers` entries override global entries with the same name.
 * `enabled: false` keeps the server in config but excludes it from connectAll.
 * `setServerEnabled` writes back to project file when the server is defined there.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mcpConfigSchema, type McpConfig, type McpServerEntry } from "./config-schema";

const CONFIG_DIR = ".mocode";
const MCP_FILE = "mcp.json";

export type McpConfigSource = "global" | "project";

export type McpConfigPaths = {
  global: string;
  project: string;
};

export type LoadMergedMcpConfigOptions = {
  globalPath?: string;
  projectPath?: string;
};

/** Returns filesystem paths for global and project MCP config files. */
export function getMcpConfigPaths(cwd: string): McpConfigPaths {
  return {
    global: join(homedir(), CONFIG_DIR, MCP_FILE),
    project: join(cwd, CONFIG_DIR, MCP_FILE),
  };
}

function readMcpJsonFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    throw error;
  }
}

function mergeRawConfig(
  globalRaw: Record<string, unknown>,
  projectRaw: Record<string, unknown>,
): McpConfig {
  const globalServers =
    globalRaw.mcpServers && typeof globalRaw.mcpServers === "object"
      ? (globalRaw.mcpServers as Record<string, unknown>)
      : {};
  const projectServers =
    projectRaw.mcpServers && typeof projectRaw.mcpServers === "object"
      ? (projectRaw.mcpServers as Record<string, unknown>)
      : {};

  const merged = {
    mcpServers: {
      ...globalServers,
      ...projectServers,
    },
  };

  const result = mcpConfigSchema.safeParse(merged);
  if (!result.success) {
    throw new Error(`Invalid MCP config: ${result.error.message}`);
  }

  return result.data;
}

/**
 * Loads and validates MCP config by merging global ~/.mocode/mcp.json with
 * project .mocode/mcp.json. Project entries override global entries by server name.
 */
export function loadMergedMcpConfig(
  cwd: string,
  options?: LoadMergedMcpConfigOptions,
): McpConfig {
  const paths =
    options?.globalPath && options?.projectPath
      ? { global: options.globalPath, project: options.projectPath }
      : getMcpConfigPaths(cwd);

  const globalRaw = readMcpJsonFile(paths.global);
  const projectRaw = readMcpJsonFile(paths.project);
  return mergeRawConfig(globalRaw, projectRaw);
}

/** Returns only servers with enabled !== false (default enabled is true). */
export function getEnabledServers(config: McpConfig): Record<string, McpServerEntry> {
  const enabled: Record<string, McpServerEntry> = {};

  for (const [name, server] of Object.entries(config.mcpServers)) {
    if (server.enabled !== false) {
      enabled[name] = server;
    }
  }

  return enabled;
}

function readRawMcpServers(path: string): Record<string, McpServerEntry> {
  const raw = readMcpJsonFile(path);
  const merged = mergeRawConfig(raw, {});
  return merged.mcpServers;
}

/** Returns whether a server entry is stored in project or global mcp.json. */
export function getServerConfigSource(
  serverName: string,
  cwd: string,
  options?: LoadMergedMcpConfigOptions,
): McpConfigSource {
  const paths =
    options?.globalPath && options?.projectPath
      ? { global: options.globalPath, project: options.projectPath }
      : getMcpConfigPaths(cwd);

  const projectRaw = readMcpJsonFile(paths.project);
  const projectServers =
    projectRaw.mcpServers && typeof projectRaw.mcpServers === "object"
      ? (projectRaw.mcpServers as Record<string, unknown>)
      : {};

  if (serverName in projectServers) {
    return "project";
  }

  return "global";
}

/**
 * Writes updated server entries back to global or project mcp.json.
 * The updater receives only servers defined in the target file.
 */
export function saveMcpConfig(
  target: McpConfigSource,
  cwd: string,
  updater: (servers: Record<string, McpServerEntry>) => Record<string, McpServerEntry>,
  options?: LoadMergedMcpConfigOptions,
): void {
  const paths =
    options?.globalPath && options?.projectPath
      ? { global: options.globalPath, project: options.projectPath }
      : getMcpConfigPaths(cwd);

  const path = target === "project" ? paths.project : paths.global;
  const dir = dirname(path);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const currentServers = readRawMcpServers(path);
  const updatedServers = updater(currentServers);
  const validated = mcpConfigSchema.parse({ mcpServers: updatedServers });

  writeFileSync(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
}

/** Persists enabled flag for a server and returns the config file that was updated. */
export function setServerEnabled(
  serverName: string,
  enabled: boolean,
  cwd: string,
): McpConfigSource {
  const source = getServerConfigSource(serverName, cwd);

  saveMcpConfig(source, cwd, (servers) => {
    const entry = servers[serverName];
    if (!entry) {
      throw new Error(`MCP server "${serverName}" not found in ${source} config`);
    }

    return {
      ...servers,
      [serverName]: {
        ...entry,
        enabled,
      },
    };
  });

  return source;
}
