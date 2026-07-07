import { describe, expect, test } from "bun:test";
import {
  formatTaskSummaryLines,
  formatTaskToolDisplay,
  getHiddenTaskSummaryLineCount,
  shouldCapTaskSummary,
  TASK_SUMMARY_MAX_VISIBLE_LINES,
} from "./bot-message-task";

describe("formatTaskToolDisplay", () => {
  test("uses description as primary when present", () => {
    const display = formatTaskToolDisplay({
      subagent_type: "explore",
      prompt: "scan lib",
      description: "Scan src/lib",
    });
    expect(display).toEqual({
      primaryText: "Scan src/lib",
      subagentType: "explore",
      showSecondarySubagentType: true,
    });
  });

  test("falls back to subagent_type when description missing", () => {
    const display = formatTaskToolDisplay({
      subagent_type: "plan-research",
      prompt: "compare options",
    });
    expect(display).toEqual({
      primaryText: "plan-research",
      subagentType: "plan-research",
      showSecondarySubagentType: false,
    });
  });
});

describe("formatTaskSummaryLines", () => {
  test("caps at 8 visible lines threshold", () => {
    const lines = formatTaskSummaryLines(
      Array.from({ length: TASK_SUMMARY_MAX_VISIBLE_LINES + 3 }, (_, i) => `line ${i + 1}`).join(
        "\n",
      ),
    );
    expect(lines).toHaveLength(TASK_SUMMARY_MAX_VISIBLE_LINES + 3);
    expect(shouldCapTaskSummary(lines)).toBe(true);
    expect(getHiddenTaskSummaryLineCount(lines)).toBe(3);
  });
});
