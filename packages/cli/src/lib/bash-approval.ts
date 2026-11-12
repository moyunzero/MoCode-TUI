/**
 * Bash approval policy (HARNESS-03).
 *
 * Two regimes, because the honest answer depends on the host:
 *
 * 1. **Confined shell** — an OS sandbox (seatbelt / bwrap) applies, so the
 *    blocklist is a backup: only listed destructive commands ask.
 * 2. **Unconfined shell** — no sandbox is available. An unsandboxed shell can read
 *    anything the user can, so a blocklist would be theatre and *every* command asks.
 *
 * Session allowlist is owned by use-chat (passed in, not a global singleton).
 */
import { isShellConfined } from "./sandbox-capability";

export type BashApprovalVerdict = "approve-once" | "reject" | "allow-session";

/**
 * D-13 destructive-command patterns. Matched against {@link normalizeCommand} output.
 * Only hits here trigger the TUI dialog; all other bash runs without interruption.
 *
 * Known limitation (accepted in Phase 01): obfuscation via env vars, aliases, or
 * unusual quoting may bypass these regexes — blocklist is a safety net, not a sandbox.
 */
const BLOCKLIST: RegExp[] = [
  /\brm\s+[^\n]*(?:--recursive\b|-[^\s-]*[rR][^\s-]*)/, // recursive delete (rm -rf, rm -R, etc.)
  /\bgit\s+push\s+[^\n]*(?:-f\b|--force\b|\+\S+)/, // force-push (-f, --force, +ref)
  /\bgit\s+reset\s+[^\n]*--hard\b/, // discard working tree + index
  /\bchmod\s+[^\n]*(-R|--recursive)\b/, // recursive permission changes
  /\b(curl|wget)\s+[^\n]*\|\s*(ba)?sh\b/, // pipe remote script directly into shell
  /\bdd\s+[^\n]*if=/, // raw disk write (dd if=/dev/...)
  // Only block devices. `2>/dev/null` is everywhere and harmless; matching it made
  // the dialog fire on ordinary commands, which trains users to approve blindly.
  />\s*\/dev\/(?:sd|disk|nvme|hd|rdisk)/, // redirect into a block device
];

/** Trim and collapse internal whitespace for blocklist and allowlist keys. */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/** Record a normalized command in the session allowlist. */
export function rememberSessionAllow(sessionAllowed: Set<string>, command: string): void {
  sessionAllowed.add(normalizeCommand(command));
}

/**
 * True when command matches the blocklist and is not session-allowed.
 *
 * `confined` describes whether the spawned shell is OS-sandboxed. It defaults to
 * the real capability, because the distinction changes the answer: an unconfined
 * shell can read anything, so a blocklist is not a safety net and *every* command
 * needs a human decision.
 */
export function requiresApproval(
  command: string,
  sessionAllowed: Set<string>,
  options: { confined?: boolean } = {},
): boolean {
  const normalized = normalizeCommand(command);
  if (sessionAllowed.has(normalized)) return false;

  const confined = options.confined ?? isShellConfined();
  if (!confined) return true;

  return BLOCKLIST.some((re) => re.test(normalized));
}
