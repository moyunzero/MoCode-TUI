/**
 * Blocklist-based bash approval for Build mode (HARNESS-03).
 *
 * Only commands matching D-13 patterns require user confirmation.
 * Session allowlist is owned by use-chat (passed in, not a global singleton).
 *
 * Limits: whitespace normalization only; obfuscation via env vars or quoting
 * may bypass patterns — acceptable per phase discretion.
 */
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
  />\s*\/dev\//, // redirect stdout/stderr into a device node
];

/** Trim and collapse internal whitespace for blocklist and allowlist keys. */
export function normalizeCommand(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

/** Record a normalized command in the session allowlist. */
export function rememberSessionAllow(sessionAllowed: Set<string>, command: string): void {
  sessionAllowed.add(normalizeCommand(command));
}

/** True when command matches the blocklist and is not session-allowed. */
export function requiresApproval(command: string, sessionAllowed: Set<string>): boolean {
  const normalized = normalizeCommand(command);
  if (sessionAllowed.has(normalized)) return false;
  return BLOCKLIST.some((re) => re.test(normalized));
}
