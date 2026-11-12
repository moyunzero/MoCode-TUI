/**
 * Permission policy for agent tools.
 *
 * Two independent concerns live here:
 *
 * 1. **Hard denies** — commands that are refused even when the user clicks
 *    "approve". Approval is for *destructive but legitimate* work; it is not a
 *    licence to format a disk. The earlier blocklist could only *ask*, so a user
 *    clicking through the dialog could still run `mkfs`.
 *
 * 2. **Environment isolation** — bash used to inherit the full `process.env`,
 *    which meant the agent could read `DEEPSEEK_API_KEY`, `CLERK_SECRET_KEY` and
 *    every other secret the CLI was started with. The sandbox env is an explicit
 *    allowlist.
 *
 * Deliberately a policy module: no I/O, no React, no process spawning.
 */

/** Coarse permission mode, mirroring the Plan/Build split the TUI already exposes. */
export type PermissionMode = "plan" | "default" | "acceptEdits" | "bypass";

export type PermissionAction = "allow" | "deny" | "ask";

/** Machine-readable refusal reasons — audited and aggregatable. */
export type PermissionCode =
  | "PATH_ESCAPE"
  | "HARD_DENY"
  | "MODE_DENIED"
  | "UNKNOWN_TOOL"
  | "RULE_DENIED";

/**
 * Refusal raised by the executor.
 *
 * The message stays human-readable (the model is told why), while `code` is what
 * audit logs and dashboards group by. Prose messages drift; codes do not.
 */
export class ToolPermissionError extends Error {
  constructor(
    readonly code: PermissionCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolPermissionError";
  }
}

export type ToolPermissionDecision = {
  action: PermissionAction;
  reason: string;
};

/** Tools that only read state; safe in every mode, including Plan. */
const READ_ONLY_TOOLS = new Set([
  "readFile",
  "listDirectory",
  "glob",
  "grep",
  "gitStatus",
  "gitDiff",
  "task",
]);

/** Tools that mutate the project tree. */
const WRITE_TOOLS = new Set(["writeFile", "editFile"]);

/**
 * Commands that are never executed, regardless of mode or approval.
 * Kept narrow on purpose — a broad list would block legitimate cleanup work.
 */
const HARD_DENY_RULES: ReadonlyArray<{ id: string; pattern: RegExp; reason: string }> = [
  {
    id: "rm-root",
    // `rm -rf /;` and `rm -rf /&&` are just as final as `rm -rf /`.
    pattern: /\brm\s+[^\n]*\s\/(?:\s|;|&|\||$)/,
    reason: "deleting the filesystem root",
  },
  {
    id: "rm-home",
    pattern: /\brm\s+[^\n]*\s(?:~|\$HOME)\/?\s?(?:$|;|\|)/,
    reason: "deleting the home directory",
  },
  {
    id: "mkfs",
    pattern: /\bmkfs(?:\.\w+)?\b/,
    reason: "formatting a filesystem",
  },
  {
    id: "dd-device",
    pattern: /\bdd\s+[^\n]*\bof=\/dev\//,
    reason: "writing raw bytes to a device node",
  },
  {
    id: "dev-redirect",
    pattern: />\s*\/dev\/(?:sd|disk|nvme|hd)/,
    reason: "redirecting output into a block device",
  },
  {
    id: "fork-bomb",
    pattern: /:\(\)\s*\{[^}]*\};?\s*:/,
    reason: "fork bomb",
  },
];

/** Returns the matching hard-deny rule, or null when the command is merely risky. */
export function findHardDeny(command: string): { id: string; reason: string } | null {
  for (const rule of HARD_DENY_RULES) {
    if (rule.pattern.test(command)) return { id: rule.id, reason: rule.reason };
  }
  return null;
}

export function isHardDenied(command: string): boolean {
  return findHardDeny(command) !== null;
}

/**
 * Decide whether a tool may run in the current mode.
 *
 * Bash is intentionally `allow` here: the finer-grained "is this specific command
 * dangerous" question is answered by `bash-approval.ts`, which drives the TUI
 * dialog. This function only answers "may this *class* of tool run at all".
 */
export function evaluateToolPermission(
  tool: string,
  mode: PermissionMode,
): ToolPermissionDecision {
  if (READ_ONLY_TOOLS.has(tool)) {
    return { action: "allow", reason: "read-only" };
  }

  if (WRITE_TOOLS.has(tool)) {
    switch (mode) {
      case "plan":
        return { action: "deny", reason: "plan mode is read-only" };
      case "acceptEdits":
        return { action: "allow", reason: "acceptEdits mode" };
      case "bypass":
        return { action: "allow", reason: "bypass mode" };
      case "default":
        return { action: "ask", reason: "write requires approval" };
    }
  }

  if (tool === "bash") {
    return mode === "plan"
      ? { action: "deny", reason: "plan mode is read-only" }
      : { action: "allow", reason: "command checked against the blocklist separately" };
  }

  // MCP and unknown tools: ask rather than guess.
  return { action: "ask", reason: "unrecognised tool" };
}

/**
 * Environment keys a spawned shell may see. Everything else — API keys especially —
 * stays out of the child process.
 */
export const SANDBOX_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "TMPDIR",
  "TMP",
  "USER",
  "LOGNAME",
  "PWD",
] as const;

/**
 * Build the child environment from an explicit allowlist.
 *
 * `TERM` is forced to `dumb` so escape sequences never leak into the TUI.
 */
export function buildSandboxEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of SANDBOX_ENV_KEYS) {
    const value = source[key];
    if (typeof value === "string") env[key] = value;
  }

  env.TERM = "dumb";
  return env;
}
