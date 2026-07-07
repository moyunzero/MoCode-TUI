/** Task tool transcript helpers (Phase 04, UI-SPEC Surfaces 1–2). */

export const TASK_SUMMARY_MAX_VISIBLE_LINES = 8;

export type TaskToolDisplay = {
  primaryText: string;
  subagentType: string;
  showSecondarySubagentType: boolean;
};

/**
 * Primary line: description if non-empty, else subagent_type (D-11).
 * Secondary dim line: subagent_type when description is present.
 */
export function formatTaskToolDisplay(input: unknown): TaskToolDisplay | null {
  if (input == null || typeof input !== "object") return null;

  const record = input as Record<string, unknown>;
  if (typeof record.subagent_type !== "string") return null;

  const subagentType = record.subagent_type;
  const description =
    typeof record.description === "string" && record.description.trim().length > 0
      ? record.description.trim()
      : undefined;

  return {
    primaryText: description ?? subagentType,
    subagentType,
    showSecondarySubagentType: description != null,
  };
}

export function formatTaskSummaryLines(summary: string): string[] {
  if (!summary) return [];
  return summary.split(/\r?\n/);
}

export function shouldCapTaskSummary(lines: string[]): boolean {
  return lines.length > TASK_SUMMARY_MAX_VISIBLE_LINES;
}

export function getHiddenTaskSummaryLineCount(lines: string[]): number {
  return Math.max(0, lines.length - TASK_SUMMARY_MAX_VISIBLE_LINES);
}

export function extractTaskSummary(part: {
  state: string;
  output?: unknown;
  errorText?: string;
}): string | null {
  if (part.state === "output-available" && part.output != null) {
    if (typeof part.output === "object" && part.output !== null && "summary" in part.output) {
      const summary = (part.output as { summary: unknown }).summary;
      return typeof summary === "string" ? summary : String(summary);
    }
  }
  if (part.state === "output-error" && part.errorText) {
    return part.errorText;
  }
  return null;
}
