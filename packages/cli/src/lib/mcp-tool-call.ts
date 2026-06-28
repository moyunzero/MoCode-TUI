/**
 * MCP tool execution handler for `use-chat` `onToolCall` (Phase 02, D-06, D-13).
 *
 * Flow:
 * 1. Normalize tool name (`Mcp__` → `mcp__`) and route only `mcp__server__tool` names
 * 2. PLAN mode — reject write tools with output-error (read-only MCP still allowed)
 * 3. BUILD write tools — `requestMcpApproval` TUI gate unless session-allowed
 * 4. `McpManager.callTool` — actual MCP SDK invocation (with auto-reconnect)
 *
 * Returns `false` when the name is not an MCP tool so the caller can fall through to
 * builtin local tools (readFile, bash, etc.).
 */
import { Mode, type ModeType } from "@mocode/shared";
import type { McpManager } from "../mcp/manager";
import { loadMergedMcpConfig } from "../mcp/config";
import {
  isMcpReadOnlyTool,
  isMcpToolName,
  normalizeMcpToolName,
  parseMcpToolName,
  requiresMcpWriteApproval,
} from "../mcp/heuristics";
import type { DialogContextValue } from "../providers/dialog";
import type { McpApprovalVerdict } from "./mcp-approval-ui";

/** Model-facing guidance when the user clicks Reject in McpApprovalDialog (mirrors bash reject pattern). */
const MCP_REJECT_ERROR_TEXT =
  "User rejected this MCP tool call in the TUI approval dialog — this is not a runtime failure. " +
  "Do not retry the same tool call unless the user explicitly requests it again in a new message.";

const PLAN_MODE_ERROR_TEXT = "Tool not available in PLAN mode";

/** Minimal shape passed from AI SDK `onToolCall` into this handler. */
export type McpToolCallInput = {
  toolName: string;
  toolCallId: string;
  input: unknown;
};

/** Injected dependencies so unit tests can mock manager, dialog, and `addToolOutput`. */
export type ExecuteMcpToolCallDeps = {
  getMcpManager: () => McpManager;
  requestMcpApproval: (
    dialog: DialogContextValue,
    toolName: string,
    input: unknown,
  ) => Promise<McpApprovalVerdict>;
  sessionMcpAllowRef: Set<string>;
  mode: ModeType;
  dialog: DialogContextValue;
  addToolOutput: (params: {
    toolCallId: string;
    output?: unknown;
    state?: "output-error";
    errorText?: string;
  }) => void;
};

/** Returns true when the tool call was handled as an MCP tool. */
export async function executeMcpToolCall(
  toolCall: McpToolCallInput,
  deps: ExecuteMcpToolCallDeps,
): Promise<boolean> {
  const { toolName: rawToolName, toolCallId, input } = toolCall;
  // Some free models emit `Mcp__filesystem__read_file` — normalize prefix only.
  const toolName = normalizeMcpToolName(rawToolName);

  if (!isMcpToolName(toolName)) {
    return false;
  }

  const { server, tool } = parseMcpToolName(toolName);

  const {
    getMcpManager,
    requestMcpApproval,
    sessionMcpAllowRef,
    mode,
    dialog,
    addToolOutput,
  } = deps;

  let toolConfig;
  try {
    const config = loadMergedMcpConfig(process.cwd());
    toolConfig = config.mcpServers[server]?.tools?.[tool];
  } catch (error) {
    addToolOutput({
      toolCallId,
      state: "output-error",
      errorText: error instanceof Error ? error.message : String(error),
    });
    return true;
  }

  // D-08: PLAN strips write MCP tools from contracts; this is a second guard at execution time.
  if (mode === Mode.PLAN && !isMcpReadOnlyTool(tool, toolConfig)) {
    addToolOutput({
      toolCallId,
      state: "output-error",
      errorText: PLAN_MODE_ERROR_TEXT,
    });
    return true;
  }

  // D-13/D-15: write tools pause for TUI approval unless "Allow for this session" was chosen.
  if (requiresMcpWriteApproval(toolName, sessionMcpAllowRef, toolConfig)) {
    const verdict = await requestMcpApproval(dialog, toolName, input);
    if (verdict === "reject") {
      addToolOutput({
        toolCallId,
        state: "output-error",
        errorText: MCP_REJECT_ERROR_TEXT,
      });
      return true;
    }
    if (verdict === "allow-session") {
      sessionMcpAllowRef.add(toolName);
    }
  }

  try {
    const args =
      input && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const output = await getMcpManager().callTool(server, tool, args);
    addToolOutput({ toolCallId, output });
  } catch (error) {
    addToolOutput({
      toolCallId,
      state: "output-error",
      errorText: error instanceof Error ? error.message : String(error),
    });
  }

  return true;
}
