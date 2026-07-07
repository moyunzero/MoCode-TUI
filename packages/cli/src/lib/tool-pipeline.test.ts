import { describe, expect, mock, test } from "bun:test";
import { runToolPipeline } from "./tool-pipeline";

describe("runToolPipeline (D-40)", () => {
  test("runs beforeHook, approval, execute, afterHook in order for bash toolCall", async () => {
    const callOrder: string[] = [];

    const beforeHook = mock(async () => {
      callOrder.push("beforeHook");
      return { allowed: true };
    });
    const approvalGate = mock(async () => {
      callOrder.push("approval");
      return { approved: true };
    });
    const executeTool = mock(async () => {
      callOrder.push("execute");
      return { ok: true };
    });
    const afterHook = mock(async () => {
      callOrder.push("afterHook");
    });

    await runToolPipeline({
      toolCall: { toolName: "bash", toolCallId: "call-1", input: { command: "echo hi" } },
      beforeHook,
      approvalGate,
      executeTool,
      afterHook,
    });

    expect(callOrder).toEqual(["beforeHook", "approval", "execute", "afterHook"]);
  });

  test("beforeHook block short-circuits — approval and execute never called", async () => {
    const callOrder: string[] = [];

    const beforeHook = mock(async () => {
      callOrder.push("beforeHook");
      return { allowed: false, reason: "blocked by hook" };
    });
    const approvalGate = mock(async () => {
      callOrder.push("approval");
      return { approved: true };
    });
    const executeTool = mock(async () => {
      callOrder.push("execute");
      return { ok: true };
    });
    const afterHook = mock(async () => {
      callOrder.push("afterHook");
    });

    const result = await runToolPipeline({
      toolCall: { toolName: "bash", toolCallId: "call-2", input: { command: "echo hi" } },
      beforeHook,
      approvalGate,
      executeTool,
      afterHook,
    });

    expect(result.blocked).toBe(true);
    expect(callOrder).toEqual(["beforeHook"]);
    expect(approvalGate).not.toHaveBeenCalled();
    expect(executeTool).not.toHaveBeenCalled();
    expect(afterHook).not.toHaveBeenCalled();
  });

  test("beforeHook block forwards hook metadata", async () => {
    const result = await runToolPipeline({
      toolCall: { toolName: "bash", toolCallId: "call-3", input: { command: "echo hi" } },
      beforeHook: async () => ({
        allowed: false,
        reason: "Hook timed out",
        hookId: "slow-hook",
        hookTimedOut: true,
      }),
      approvalGate: async () => ({ approved: true }),
      executeTool: async () => ({}),
      afterHook: async () => {},
    });

    expect(result).toEqual({
      blocked: true,
      reason: "Hook timed out",
      blockedBy: "hook",
      hookId: "slow-hook",
      hookTimedOut: true,
    });
  });
});
