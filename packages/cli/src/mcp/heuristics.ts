/**
 * MCP tool read/write heuristics (Phase 02, D-08, D-13).
 *
 * Read-only detection mirrors PLAN mode local tools: prefix heuristic plus
 * optional per-tool `readOnly` override from mcp.json.
 */
import { Mode, type ModeType } from "@mocode/shared";

const MCP_PREFIX = "mcp__";
const READ_ONLY_PREFIX = /^(get|list|read|fetch|search)_/i;

export type McpToolConfigOverride = {
  readOnly?: boolean;
};

function hasMcpToolShape(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) {
    return false;
  }
  const rest = name.slice(prefix.length);
  const separator = rest.indexOf("__");
  return separator > 0 && separator < rest.length - 2;
}

/** True when the tool name uses canonical MCP naming (`mcp__server__tool`). */
export function isMcpToolName(name: string): boolean {
  return hasMcpToolShape(name, MCP_PREFIX);
}

/** True for canonical or mixed-case MCP tool names (e.g. `Mcp__server__tool`). */
export function looksLikeMcpToolName(name: string): boolean {
  return isMcpToolName(name) || hasMcpToolShape(name.toLowerCase(), MCP_PREFIX);
}

/** Normalizes mixed-case MCP prefix to canonical `mcp__` without changing server/tool segments. */
export function normalizeMcpToolName(name: string): string {
  if (isMcpToolName(name)) {
    return name;
  }
  if (!looksLikeMcpToolName(name)) {
    return name;
  }
  return MCP_PREFIX + name.slice(MCP_PREFIX.length);
}

/** Splits `mcp__<server>__<tool>` into server and raw MCP tool segments. */
export function parseMcpToolName(fullName: string): { server: string; tool: string } {
  if (!isMcpToolName(fullName)) {
    throw new Error(`Invalid MCP tool name: ${fullName}`);
  }

  const rest = fullName.slice(MCP_PREFIX.length);
  const separator = rest.indexOf("__");
  if (separator === -1) {
    throw new Error(`Invalid MCP tool name: ${fullName}`);
  }

  return {
    server: rest.slice(0, separator),
    tool: rest.slice(separator + 2),
  };
}

function rawToolName(toolNameOrFullName: string): string {
  return isMcpToolName(toolNameOrFullName)
    ? parseMcpToolName(toolNameOrFullName).tool
    : toolNameOrFullName;
}

/**
 * True when an MCP tool is read-only by prefix heuristic or config override.
 * Evaluates the raw MCP tool name (not the full `mcp__` name).
 */
export function isMcpReadOnlyTool(
  rawToolName: string,
  toolConfig?: McpToolConfigOverride,
): boolean {
  if (toolConfig?.readOnly === true) {
    return true;
  }
  if (toolConfig?.readOnly === false) {
    return false;
  }
  return READ_ONLY_PREFIX.test(rawToolName);
}

/**
 * In PLAN mode write tools are omitted from contracts, so this always returns false.
 * In BUILD mode (or when called with a session allowlist Set) write tools require approval
 * unless session-allowed or classified read-only.
 *
 * Overload: pass `Set<string>` from use-chat (session allowlist) or `ModeType` when
 * filtering tool registration only (no session context).
 */
export function requiresMcpWriteApproval(
  toolNameOrFullName: string,
  sessionAllowedOrMode: Set<string> | ModeType,
  toolConfig?: McpToolConfigOverride,
): boolean {
  let mode: ModeType | undefined;
  let sessionAllowed: Set<string>;

  if (sessionAllowedOrMode instanceof Set) {
    sessionAllowed = sessionAllowedOrMode;
  } else {
    mode = sessionAllowedOrMode;
    sessionAllowed = new Set();
  }

  if (mode === Mode.PLAN) {
    return false;
  }

  const rawName = rawToolName(toolNameOrFullName);
  if (isMcpReadOnlyTool(rawName, toolConfig)) {
    return false;
  }

  const approvalKey = isMcpToolName(toolNameOrFullName)
    ? toolNameOrFullName
    : toolNameOrFullName;

  if (sessionAllowed.has(approvalKey)) {
    return false;
  }

  return true;
}
