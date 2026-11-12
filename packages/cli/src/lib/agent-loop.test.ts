import { describe, expect, test } from "bun:test";
import { AgentLoop, DEFAULT_AGENT_LIMITS, formatAgentProgress, toolSignature } from "./agent-loop";

describe("AgentLoop turn budget", () => {
  test("allows maxTurns turns, then stops with a named reason", () => {
    const loop = new AgentLoop({ maxTurns: 3 });

    expect(loop.beginTurn().action).toBe("continue");
    expect(loop.beginTurn().action).toBe("continue");
    expect(loop.beginTurn().action).toBe("continue");

    const decision = loop.beginTurn();
    expect(decision).toEqual({
      action: "stop",
      reason: "max-turns",
      detail: "Stopped after 3 turns without a final answer.",
    });
  });

  test("stop is sticky and reports the original reason", () => {
    const loop = new AgentLoop({ maxTurns: 1 });
    loop.beginTurn();
    loop.beginTurn();

    expect(loop.beginTurn()).toEqual(loop.beginTurn());
    expect(loop.stopped).toBe("max-turns");
  });
});

describe("AgentLoop tool budget", () => {
  test("caps tool calls inside one turn and resets per turn", () => {
    const loop = new AgentLoop({ maxToolCallsPerTurn: 2 });

    loop.beginTurn();
    expect(loop.recordToolCall("readFile", { path: "a" }).action).toBe("continue");
    expect(loop.recordToolCall("readFile", { path: "b" }).action).toBe("continue");

    const capped = loop.recordToolCall("readFile", { path: "c" });
    expect(capped).toMatchObject({ action: "stop", reason: "max-tool-calls" });
  });

  test("a new turn restores the per-turn budget", () => {
    const loop = new AgentLoop({ maxToolCallsPerTurn: 1 });

    loop.beginTurn();
    loop.recordToolCall("readFile", { path: "a" });
    expect(loop.recordToolCall("readFile", { path: "b" }).action).toBe("stop");

    const fresh = new AgentLoop({ maxToolCallsPerTurn: 1 });
    fresh.beginTurn();
    fresh.recordToolCall("readFile", { path: "a" });
    fresh.beginTurn();
    expect(fresh.recordToolCall("readFile", { path: "b" }).action).toBe("continue");
  });
});

describe("AgentLoop repeat guard", () => {
  test("stops when an identical call repeats consecutively beyond the threshold", () => {
    const loop = new AgentLoop({ maxConsecutiveRepeats: 3 });
    loop.beginTurn();

    for (let i = 0; i < 3; i += 1) {
      expect(loop.recordToolCall("bash", { command: "ls" }).action).toBe("continue");
    }

    expect(loop.recordToolCall("bash", { command: "ls" })).toMatchObject({
      action: "stop",
      reason: "no-progress",
    });
  });

  test("read → edit → read is normal work, not a loop", () => {
    const loop = new AgentLoop({ maxConsecutiveRepeats: 1 });
    loop.beginTurn();

    expect(loop.recordToolCall("readFile", { path: "a" }).action).toBe("continue");
    expect(loop.recordToolCall("editFile", { path: "a" }).action).toBe("continue");
    expect(loop.recordToolCall("readFile", { path: "a" }).action).toBe("continue");
  });

  test("same tool with different input does not count as a repeat", () => {
    const loop = new AgentLoop({ maxConsecutiveRepeats: 1 });
    loop.beginTurn();

    expect(loop.recordToolCall("readFile", { path: "a" }).action).toBe("continue");
    expect(loop.recordToolCall("readFile", { path: "b" }).action).toBe("continue");
    expect(loop.recordToolCall("readFile", { path: "c" }).action).toBe("continue");
  });

  test("signature is insensitive to key order", () => {
    expect(toolSignature("grep", { pattern: "x", path: "a" })).toBe(
      toolSignature("grep", { path: "a", pattern: "x" }),
    );
    expect(toolSignature("grep", { pattern: "x" })).not.toBe(
      toolSignature("grep", { pattern: "y" }),
    );
  });
});

describe("AgentLoop lifecycle", () => {
  test("a new user message resets the budget", () => {
    const loop = new AgentLoop({ maxTurns: 1 });

    loop.beginUserMessage("user-1");
    loop.beginTurn();
    expect(loop.beginTurn().action).toBe("stop");

    loop.beginUserMessage("user-2");
    expect(loop.beginTurn().action).toBe("continue");
  });

  test("regenerating the same message keeps the budget", () => {
    const loop = new AgentLoop({ maxTurns: 1 });

    loop.beginUserMessage("user-1");
    loop.beginTurn();
    loop.beginTurn();
    loop.beginUserMessage("user-1");

    expect(loop.stopped).toBe("max-turns");
  });

  test("reset() clears a stop so an explicit retry can proceed", () => {
    const loop = new AgentLoop({ maxTurns: 1 });

    loop.beginUserMessage("user-1");
    loop.beginTurn();
    loop.beginTurn();

    loop.reset();
    expect(loop.stopped).toBeNull();
    expect(loop.beginTurn().action).toBe("continue");
  });

  test("abort() is sticky", () => {
    const loop = new AgentLoop();
    loop.beginUserMessage("user-1");
    loop.beginTurn();
    loop.abort();

    expect(loop.stopped).toBe("aborted");
    expect(loop.beginTurn()).toMatchObject({ action: "stop", reason: "aborted" });
  });

  test("snapshot reports budget usage", () => {
    const loop = new AgentLoop({ maxTurns: 5, maxToolCallsPerTurn: 4 });
    loop.beginUserMessage("user-1");
    loop.beginTurn();
    loop.recordToolCall("readFile", { path: "a" });
    loop.recordToolCall("readFile", { path: "b" });

    expect(loop.snapshot()).toEqual({
      turn: 1,
      maxTurns: 5,
      toolCallsThisTurn: 2,
      totalToolCalls: 2,
      stopReason: null,
    });
  });

  test("defaults are exposed for the TUI status line", () => {
    expect(DEFAULT_AGENT_LIMITS.maxTurns).toBeGreaterThan(0);
  });
});

describe("formatAgentProgress", () => {
  test("renders nothing before a run starts", () => {
    expect(formatAgentProgress(null)).toBeNull();
    expect(formatAgentProgress({ turn: 0, maxTurns: 24, toolCallsThisTurn: 0 })).toBeNull();
  });

  test("renders the turn budget", () => {
    expect(formatAgentProgress({ turn: 3, maxTurns: 24, toolCallsThisTurn: 0 })).toBe("turn 4/25");
  });

  test("appends the tool count once the turn has run tools", () => {
    expect(formatAgentProgress({ turn: 3, maxTurns: 24, toolCallsThisTurn: 4 })).toBe(
      "turn 4/25 · 4 tools",
    );
  });

  test("uses the singular label for a single tool call", () => {
    expect(formatAgentProgress({ turn: 1, maxTurns: 24, toolCallsThisTurn: 1 })).toBe(
      "turn 2/25 · 1 tool",
    );
  });
});
