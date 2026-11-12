import { describe, expect, test } from "bun:test";
import {
  deriveAgentPhase,
  isRunActive,
  formatAgentPhase,
  formatElapsed,
  type PhaseMessage,
} from "./agent-phase";

function message(parts: unknown[]): PhaseMessage {
  return { parts };
}

const pendingTool = { type: "tool-bash", state: "input-available" };
const doneTool = { type: "tool-bash", state: "output-available" };
const reasoning = { type: "reasoning" };
const text = { type: "text" };

describe("isRunActive", () => {
  test("status alone does not decide it", () => {
    // The loop is client-driven: between a model step and the auto-resubmit the
    // status is `ready` while tools are still executing.
    expect(isRunActive({ status: "ready", message: message([pendingTool]) })).toBe(true);
  });

  test("idle once the last tool call is resolved", () => {
    expect(isRunActive({ status: "ready", message: message([doneTool]) })).toBe(false);
  });

  test("streaming is active even with no parts yet", () => {
    expect(isRunActive({ status: "streaming" })).toBe(true);
  });
});

describe("deriveAgentPhase", () => {
  test("stays 'running' in the gap between a step and the resubmit", () => {
    expect(deriveAgentPhase({ status: "ready", message: message([pendingTool]) })).toBe("running");
  });

  test("idle when the chat is not running", () => {
    expect(deriveAgentPhase({ status: "ready", message: message([text]) })).toBeNull();
    expect(deriveAgentPhase({ status: "error" })).toBeNull();
  });

  test("waiting for the first token", () => {
    expect(deriveAgentPhase({ status: "submitted" })).toBe("waiting");
    expect(deriveAgentPhase({ status: "streaming", message: message([]) })).toBe("waiting");
  });

  test("thinking while only reasoning has streamed", () => {
    expect(deriveAgentPhase({ status: "streaming", message: message([reasoning]) })).toBe(
      "thinking",
    );
  });

  test("generating once text appears", () => {
    expect(deriveAgentPhase({ status: "streaming", message: message([reasoning, text]) })).toBe(
      "generating",
    );
  });

  test("running wins over text — the agent is acting, not talking", () => {
    expect(
      deriveAgentPhase({ status: "streaming", message: message([text, pendingTool]) }),
    ).toBe("running");
  });

  test("a resolved tool no longer counts as running", () => {
    expect(deriveAgentPhase({ status: "streaming", message: message([text, doneTool]) })).toBe(
      "generating",
    );
  });

  test("dynamic MCP calls count as running too", () => {
    expect(
      deriveAgentPhase({
        status: "streaming",
        message: message([{ type: "dynamic-tool", state: "input-available" }]),
      }),
    ).toBe("running");
  });

  test("tool parts with no state yet are treated as pending", () => {
    expect(
      deriveAgentPhase({ status: "streaming", message: message([{ type: "tool-readFile" }]) }),
    ).toBe("running");
  });
});

describe("formatElapsed", () => {
  test("shows tenths under a minute", () => {
    expect(formatElapsed(2_400)).toBe("2.4s");
    expect(formatElapsed(0)).toBe("0.0s");
  });

  test("switches to minutes past 60s, like the harness does", () => {
    expect(formatElapsed(174_000)).toBe("2m54s");
  });

  test("never goes negative", () => {
    expect(formatElapsed(-500)).toBe("0.0s");
  });
});

describe("formatAgentPhase", () => {
  test("idle renders nothing", () => {
    expect(formatAgentPhase(null, 1_000)).toBeNull();
  });

  test("shows the phase with elapsed time", () => {
    expect(formatAgentPhase("running", 2_400)).toBe("执行中 2.4s");
    expect(formatAgentPhase("thinking", 1_000)).toBe("思考中 1.0s");
  });

  test("omits the timer when the elapsed time is unknown", () => {
    expect(formatAgentPhase("waiting", null)).toBe("等待首字");
  });
});
