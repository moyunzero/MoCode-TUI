import { describe, expect, test } from "bun:test";
import {
  buildSlashSubagentPair,
  finalizeSlashSubagentAssistant,
  normalizeSubagentSummary,
  shouldShowPendingTranscriptReply,
  transcriptHasPendingTask,
} from "./slash-subagent-transcript";

describe("buildSlashSubagentPair", () => {
  test("creates pending tool-task assistant before subagent runs", () => {
    const { user, assistant, toolCallId } = buildSlashSubagentPair({
      type: "explore",
      prompt: "src/lib",
      slashLine: "/explore src/lib",
      mode: "BUILD",
      model: "gemini-2.5-flash",
      now: 1,
    });

    expect(user.parts[0]).toEqual({ type: "text", text: "/explore src/lib" });
    expect(assistant.parts[0]).toMatchObject({
      type: "tool-task",
      toolCallId,
      state: "input-available",
      input: {
        subagent_type: "explore",
        prompt: "src/lib",
        description: "src/lib",
      },
    });
  });
});

describe("normalizeSubagentSummary", () => {
  test("returns fallback when success summary is blank", () => {
    expect(normalizeSubagentSummary("  ", { summary: "  " })).toBe(
      "Subagent finished without a text summary.",
    );
  });
});

describe("finalizeSlashSubagentAssistant", () => {
  test("marks tool-task output-available with summary", () => {
    const { assistant, toolCallId } = buildSlashSubagentPair({
      type: "explore",
      prompt: "src/lib",
      slashLine: "/explore src/lib",
      mode: "BUILD",
      model: "gemini-2.5-flash",
      now: 2,
    });

    const finalized = finalizeSlashSubagentAssistant(
      assistant,
      toolCallId,
      {
        subagent_type: "explore",
        prompt: "src/lib",
        description: "src/lib",
      },
      { summary: "Found 3 modules" },
    );

    expect(finalized.parts[0]).toMatchObject({
      state: "output-available",
      output: { summary: "Found 3 modules" },
    });
  });
});

describe("shouldShowPendingTranscriptReply", () => {
  test("returns false while subagentRunning (no Generating placeholder)", () => {
    expect(
      shouldShowPendingTranscriptReply({
        isLoading: true,
        lastMessageRole: "user",
        subagentRunning: true,
        hasPendingTaskInTranscript: false,
      }),
    ).toBe(false);
  });

  test("returns false when pending Task row is already visible", () => {
    expect(
      shouldShowPendingTranscriptReply({
        isLoading: true,
        lastMessageRole: "assistant",
        subagentRunning: false,
        hasPendingTaskInTranscript: true,
      }),
    ).toBe(false);
  });

  test("returns true for normal chat streaming with user tail", () => {
    expect(
      shouldShowPendingTranscriptReply({
        isLoading: true,
        lastMessageRole: "user",
        subagentRunning: false,
        hasPendingTaskInTranscript: false,
      }),
    ).toBe(true);
  });
});

describe("transcriptHasPendingTask", () => {
  test("detects input-available tool-task on last assistant message", () => {
    const messages = [
      { role: "user", parts: [{ type: "text", text: "/explore src/lib" }] },
      {
        role: "assistant",
        parts: [{ type: "tool-task", state: "input-available" }],
      },
    ];

    expect(transcriptHasPendingTask(messages)).toBe(true);
  });
});
