/**
 * Tool-name glob matching for hooks.json entries (Phase 04, D-35).
 *
 * Supports exact names (`bash`, `writeFile`) and trailing `*` suffix globs (`mcp__*`).
 */
export function matchesToolName(toolName: string, matcher: string): boolean {
  if (matcher.endsWith("*")) {
    const prefix = matcher.slice(0, -1);
    return toolName.startsWith(prefix);
  }
  return toolName === matcher;
}
