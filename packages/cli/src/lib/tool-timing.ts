/**
 * Per-tool start times, so a running tool can show how long it has been running.
 *
 * Deliberately a tiny side-table rather than a field on the message part: adding a
 * field would mean mutating SDK-owned message data, and the number is presentation
 * only. Entries are keyed by `toolCallId`, which is unique per call.
 *
 * The map is bounded — a long session with hundreds of calls must not leak.
 */

const startedAt = new Map<string, number>();

/** Cap on retained entries; oldest are evicted first. */
const MAX_ENTRIES = 512;

/** Record when a tool call began. Safe to call twice (first write wins). */
export function markToolStarted(toolCallId: string, now: number = Date.now()): void {
  if (startedAt.has(toolCallId)) return;

  if (startedAt.size >= MAX_ENTRIES) {
    const oldest = startedAt.keys().next();
    if (!oldest.done) startedAt.delete(oldest.value);
  }

  startedAt.set(toolCallId, now);
}

/** Milliseconds since the call began, or `null` when it was never marked. */
export function toolElapsedMs(toolCallId: string, now: number = Date.now()): number | null {
  const start = startedAt.get(toolCallId);
  return start === undefined ? null : Math.max(0, now - start);
}

export function clearToolTiming(toolCallId: string): void {
  startedAt.delete(toolCallId);
}

/** Drop all entries — used when a new run starts and by tests. */
export function resetToolTimings(): void {
  startedAt.clear();
}

/** Compact label for a running tool, e.g. `2.3s`. */
export function formatToolElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}
