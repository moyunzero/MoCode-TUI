import { describe, expect, test } from "bun:test";
import { selectStatusHints, StatusBar } from "./status-bar";
import { renderLines, renderText } from "../testing/render";

describe("StatusBar", () => {
  test("idle: shows mode, model and hints, but no loop budget", async () => {
    const frame = await renderText(<StatusBar />);

    expect(frame).toContain("Build");
    expect(frame).toContain(">");
    expect(frame).toContain("提交");
    expect(frame).toContain("换行");
    expect(frame).not.toContain("turn");
    expect(frame).not.toContain("tools");
  });

  test("shows the turn budget once a run has continued", async () => {
    const frame = await renderText(
      <StatusBar agentProgress={{ turn: 3, maxTurns: 50, toolCallsThisTurn: 0 }} />,
    );

    expect(frame).toContain("turn 4/51");
    expect(frame).not.toContain("tools");
  });

  test("appends the tool count for the current turn", async () => {
    const frame = await renderText(
      <StatusBar agentProgress={{ turn: 3, maxTurns: 50, toolCallsThisTurn: 4 }} />,
    );

    expect(frame).toContain("turn 4/51 · 4 tools");
  });

  test("hides the budget before the first continued turn", async () => {
    const frame = await renderText(
      <StatusBar agentProgress={{ turn: 0, maxTurns: 50, toolCallsThisTurn: 0 }} />,
    );

    expect(frame).not.toContain("turn");
  });

  test("keeps the whole status line on a single row (DESIGN.md: status-row = 1)", async () => {
    const lines = await renderLines(
      <StatusBar agentProgress={{ turn: 12, maxTurns: 50, toolCallsThisTurn: 9 }} />,
      { width: 100, height: 4 },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("turn 13/51 · 9 tools");
  });

  test("subagent footer replaces the budget while a Task runs", async () => {
    const frame = await renderText(
      <StatusBar
        subagentRunning
        subagentType="explore"
        agentProgress={{ turn: 3, maxTurns: 50, toolCallsThisTurn: 4 }}
      />,
    );

    expect(frame).toContain("explore");
    expect(frame).toContain("esc to interrupt");
    expect(frame).not.toContain("turn");
  });

  test("shows a downgrade notice when a fallback model answered", async () => {
    const frame = await renderText(
      <StatusBar agentDowngrade={{ from: "gpt-oss-120b", to: "deepseek-flash" }} />,
    );

    expect(frame).toContain("fallback → deepseek-flash");
  });

  test("shows no downgrade notice on a normal turn", async () => {
    const frame = await renderText(<StatusBar />);

    expect(frame).not.toContain("fallback");
  });

  test("narrow width with downgrade + budget stays on one row and drops newline first", async () => {
    const lines = await renderLines(
      <StatusBar
        agentDowngrade={{ from: "gpt-oss-120b", to: "deepseek-flash" }}
        agentProgress={{ turn: 12, maxTurns: 50, toolCallsThisTurn: 9 }}
      />,
      // Wide enough for mode/model/downgrade/budget; tight enough to drop newline/note.
      { width: 72, height: 4 },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("fallback → deepseek-flash");
    expect(lines[0]).toContain("turn 13/51");
    expect(lines[0]).not.toContain("换行");
  });
});

describe("selectStatusHints", () => {
  const hint = { submit: "↵", newline: "⇧↵", note: "Ctrl+J" };

  test("keeps every hint when there is room", () => {
    expect(selectStatusHints(120, 20, hint)).toEqual({
      showSubmit: true,
      showNewline: true,
      showNote: true,
    });
  });

  test("drops newline before submit under pressure", () => {
    expect(selectStatusHints(40, 30, hint)).toEqual({
      showSubmit: true,
      showNewline: false,
      showNote: false,
    });
  });
});

describe("live agent phase", () => {
  test("shows the running phase with a counting timer", async () => {
    const frame = await renderText(
      <StatusBar agentPhase="running" agentElapsedMs={2400} />,
    );

    expect(frame).toContain("执行中 2.4s");
  });

  test("thinking and generating are distinguishable", async () => {
    const thinking = await renderText(<StatusBar agentPhase="thinking" agentElapsedMs={1000} />);
    const generating = await renderText(
      <StatusBar agentPhase="generating" agentElapsedMs={9000} />,
    );

    expect(thinking).toContain("思考中 1.0s");
    expect(generating).toContain("生成中 9.0s");
  });

  test("idle shows no phase at all", async () => {
    const frame = await renderText(<StatusBar />);

    expect(frame).not.toContain("s ·");
    expect(frame).not.toContain("执行中");
  });

  test("phase and budget coexist on one row", async () => {
    const lines = await renderLines(
      <StatusBar
        agentPhase="running"
        agentElapsedMs={2400}
        agentProgress={{ turn: 2, maxTurns: 50, toolCallsThisTurn: 3 }}
      />,
      { width: 110, height: 4 },
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("执行中 2.4s");
    expect(lines[0]).toContain("turn 3/51");
  });
});
