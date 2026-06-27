# Agent permissions (Build mode)

MoCode separates **who enforces permissions** from **who invokes shell commands**, aligned with Claude Code harness behavior.

## CLI TUI is the permission gate

Dangerous bash commands are blocked by a **blocklist** in the CLI (`packages/cli/src/lib/bash-approval.ts`, via `requiresApproval()` called from `use-chat.ts`), not by the model asking in chat. When a command matches the blocklist:

1. Execution pauses before the command runs.
2. A TUI modal appears: **Approve once** / **Reject** / **Allow for this session**.
3. Keyboard navigation: **↑ / ↓** to move, **Enter** to confirm, **Esc** to reject.

Non-blocklisted commands (e.g. `npm test`, `git status`) run immediately with no dialog.

## Model behavior

In Build mode the model should:

- **Invoke bash directly** for shell work — do not ask in chat whether to run a command first.
- Treat the **TUI approval dialog as the sole confirmation** for dangerous commands; chat messages are not a permission gate.
- **Not retry** a rejected command unless the user explicitly asks again. On rejection, acknowledge and suggest alternatives.
- Use the optional **`description`** field on bash tool calls when the command string alone does not convey intent (shown as a dim line in the transcript).

## Plan mode

Plan mode has no bash tool. Git inspection uses read-only `gitStatus` and `gitDiff` tools instead.
