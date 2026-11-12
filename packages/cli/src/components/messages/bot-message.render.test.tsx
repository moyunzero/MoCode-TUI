import { describe, expect, test } from "bun:test";
import { Mode } from "@mocode/shared";
import { BotMessage } from "./bot-message";
import { renderText } from "../../testing/render";
import { markToolStarted, resetToolTimings } from "../../lib/tool-timing";

type Part = Parameters<typeof BotMessage>[0]["parts"][number];

function pendingTool(id: string): Part {
  return {
    type: "tool-bash",
    toolCallId: id,
    state: "input-available",
    input: { command: "npm test", description: "run tests" },
  } as unknown as Part;
}

describe("BotMessage tool timing", () => {
  test("a running tool shows how long it has been running", async () => {
    resetToolTimings();
    markToolStarted("call-1", Date.now() - 2_300);

    const frame = await renderText(
      <BotMessage parts={[pendingTool("call-1")]} model="deepseek-flash" mode={Mode.BUILD} />,
      { width: 100, height: 8 },
    );

    expect(frame).toContain("2.3s");
    expect(frame).toContain("npm test");
  });

  test("a finished tool shows no timer", async () => {
    resetToolTimings();
    markToolStarted("call-1", Date.now() - 2_300);

    const finished = {
      type: "tool-bash",
      toolCallId: "call-1",
      state: "output-available",
      input: { command: "npm test" },
      output: { stdout: "ok", stderr: "", exitCode: 0 },
    } as unknown as Part;

    const frame = await renderText(
      <BotMessage parts={[finished]} model="deepseek-flash" mode={Mode.BUILD} />,
      { width: 100, height: 8 },
    );

    expect(frame).not.toContain("2.3s");
  });
});
