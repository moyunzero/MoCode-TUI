import { beforeEach, describe, expect, mock, test } from "bun:test";
import { runSubagent } from "./runner";

const generateTextMock = mock(async () => ({
  text: "Subagent completed: found 3 auth handlers.",
  steps: [{ stepType: "initial" }],
}));

mock.module("ai", () => ({
  generateText: generateTextMock,
}));

describe("runSubagent (D-03, D-07, D-10)", () => {
  beforeEach(() => {
    generateTextMock.mockClear();
  });

  test("returns summary-only result without inner messages array (D-03)", async () => {
    const result = await runSubagent({
      subagent_type: "explore",
      prompt: "Find auth handlers",
      mode: "BUILD",
      abortSignal: undefined,
    });

    expect(result.summary).toBe("Subagent completed: found 3 auth handlers.");
    expect(result).not.toHaveProperty("messages");
    expect(Object.keys(result)).not.toContain("messages");
  });

  test("passes stopWhen cap of 25 steps to generateText (D-07)", async () => {
    await runSubagent({
      subagent_type: "explore",
      prompt: "Scan codebase",
      mode: "BUILD",
      abortSignal: undefined,
    });

    expect(generateTextMock).toHaveBeenCalled();
    const call = generateTextMock.mock.calls[0]?.[0] as { stopWhen?: unknown };
    expect(call.stopWhen).toBeDefined();

    const stopWhen = call.stopWhen as { stepCount?: number; maxSteps?: number } | ((args: { steps: unknown[] }) => boolean);
    if (typeof stopWhen === "function") {
      const steps = Array.from({ length: 25 }, () => ({}));
      expect(stopWhen({ steps })).toBe(true);
      expect(stopWhen({ steps: steps.slice(0, 24) })).toBe(false);
    } else {
      expect(stopWhen.stepCount ?? stopWhen.maxSteps).toBe(25);
    }
  });

  test("abortSignal returns interrupted summary (D-10)", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagent({
      subagent_type: "plan-research",
      prompt: "Compare options",
      mode: "PLAN",
      abortSignal: controller.signal,
    });

    expect(result.summary.toLowerCase()).toMatch(/interrupt/);
    expect(result.interrupted).toBe(true);
  });
});
