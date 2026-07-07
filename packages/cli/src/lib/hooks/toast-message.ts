/** Hook-block toast copy (Phase 04 UI-SPEC §4). */
export function formatHookBlockToast(
  toolName: string,
  params: { reason?: string; hookId?: string; hookTimedOut?: boolean },
): string {
  if (params.hookTimedOut && params.hookId) {
    return `Hook timed out — ${params.hookId} blocked ${toolName}`;
  }
  return `Hook blocked ${toolName}: ${params.reason ?? "Tool execution blocked"}`;
}
