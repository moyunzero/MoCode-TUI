/**
 * Bridge from async `onToolCall` to the modal DialogProvider for MCP write approval (D-15).
 *
 * Mirrors `requestBashApproval` UX: Approve once / Reject / Allow for session.
 * Esc / backdrop dismiss → reject (same as bash approval). Session allowlist keyed by
 * full `mcp__<server>__<tool>` string is owned by `use-chat` `sessionMcpAllowRef`.
 */
import { createElement } from "react";
import { McpApprovalDialog } from "../components/dialogs/mcp-approval-dialog";
import type { DialogContextValue } from "../providers/dialog";

/** User choice from McpApprovalDialog — maps 1:1 to bash approval verdicts. */
export type McpApprovalVerdict = "approve-once" | "reject" | "allow-session";

/**
 * Opens McpApprovalDialog and resolves when the user picks an action or dismisses.
 * `settled` prevents double-resolve if both a button and `onClose` fire.
 */
export function requestMcpApproval(
  dialog: DialogContextValue,
  toolName: string,
  input: unknown,
): Promise<McpApprovalVerdict> {
  return new Promise((resolve) => {
    let settled = false;

    const settle = (verdict: McpApprovalVerdict) => {
      if (settled) return;
      settled = true;
      resolve(verdict);
    };

    dialog.open({
      title: "Approve MCP tool call",
      onClose: () => settle("reject"),
      children: createElement(McpApprovalDialog, {
        toolName,
        input,
        onApproveOnce: () => {
          settle("approve-once");
          dialog.close();
        },
        onReject: () => {
          settle("reject");
          dialog.close();
        },
        onAllowSession: () => {
          settle("allow-session");
          dialog.close();
        },
      }),
    });
  });
}
