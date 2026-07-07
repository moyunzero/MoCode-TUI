import { describe, expect, test } from "bun:test";
import { Mode } from "@mocode/shared";
import {
  formatAssistantFooter,
  shouldShowAssistantMessageFooter,
  shouldShowDurationInFooter,
  shouldShowGeneratingInFooter,
} from "./bot-message-footer";

describe("shouldShowDurationInFooter (D-09, D-21)", () => {
  test("hides duration while streaming", () => {
    expect(shouldShowDurationInFooter({ streaming: true, durationMs: 3200 })).toBe(false);
  });

  test("shows duration when not streaming and durationMs set", () => {
    expect(shouldShowDurationInFooter({ streaming: false, durationMs: 3200 })).toBe(true);
  });
});

describe("formatAssistantFooter (D-09, D-21)", () => {
  test("includes formatted duration when not streaming", () => {
    const footer = formatAssistantFooter({
      mode: Mode.BUILD,
      model: "claude-sonnet-4-6",
      durationMs: 3200,
      streaming: false,
    });
    expect(footer).toContain("3.2s");
  });

  test("never contains INTERRUPTED banner literal (D-09)", () => {
    const footer = formatAssistantFooter({
      mode: Mode.BUILD,
      model: "claude-sonnet-4-6",
      durationMs: 1000,
      streaming: false,
    });
    expect(footer.toUpperCase()).not.toContain("INTERRUPTED");
  });

  test("includes usage token counts when present (D-21)", () => {
    const footer = formatAssistantFooter({
      mode: Mode.BUILD,
      model: "claude-sonnet-4-6",
      durationMs: 500,
      streaming: false,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    expect(footer).toContain("100");
    expect(footer).toContain("50");
    expect(footer).not.toContain("150");
  });

  test("suppresses usage token counts while streaming", () => {
    const footer = formatAssistantFooter({
      mode: Mode.BUILD,
      model: "claude-sonnet-4-6",
      durationMs: 500,
      streaming: true,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
    expect(footer).not.toContain("↑100");
    expect(footer).not.toContain("↓50");
  });
});

describe("shouldShowAssistantMessageFooter", () => {
  test("hides footer for tool-task-only assistant messages", () => {
    expect(shouldShowAssistantMessageFooter([{ type: "tool-task" }])).toBe(false);
  });

  test("shows footer when assistant has text", () => {
    expect(
      shouldShowAssistantMessageFooter([{ type: "tool-task" }, { type: "text" }]),
    ).toBe(true);
  });
});

describe("shouldShowGeneratingInFooter", () => {
  test("suppresses generating label when tools are pending", () => {
    expect(
      shouldShowGeneratingInFooter({
        streaming: true,
        hasTextPart: false,
        toolsPending: true,
      }),
    ).toBe(false);
  });
});
