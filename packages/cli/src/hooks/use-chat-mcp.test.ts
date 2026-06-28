import { describe, expect, test, mock } from "bun:test";
import { Mode } from "@mocode/shared";
import { executeMcpToolCall } from "../lib/mcp-tool-call";
import type { McpManager } from "../mcp/manager";

function createDeps(overrides: Partial<{
  requestMcpApproval: ReturnType<typeof mock>;
  sessionMcpAllowRef: Set<string>;
  mode: typeof Mode.BUILD;
}> = {}) {
  const sessionMcpAllowRef = overrides.sessionMcpAllowRef ?? new Set<string>();
  const callTool = mock(() => Promise.resolve({ content: [{ type: "text", text: "ok" }] }));
  const requestMcpApproval =
    overrides.requestMcpApproval ??
    mock(() => Promise.resolve("approve-once" as const));
  const addToolOutput = mock(() => {});

  const getMcpManager = () =>
    ({
      callTool,
    }) as unknown as McpManager;

  const deps = {
    getMcpManager,
    requestMcpApproval,
    sessionMcpAllowRef,
    mode: overrides.mode ?? Mode.BUILD,
    dialog: {} as never,
    addToolOutput,
  };

  return { deps, callTool, requestMcpApproval, addToolOutput, sessionMcpAllowRef };
}

describe("executeMcpToolCall", () => {
  test("read-only MCP tool calls callTool without approval", async () => {
    const { deps, callTool, requestMcpApproval } = createDeps();
    const handled = await executeMcpToolCall(
      { toolName: "mcp__fs__get_file", toolCallId: "tc1", input: { path: "/tmp" } },
      deps,
    );

    expect(handled).toBe(true);
    expect(requestMcpApproval).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("fs", "get_file", { path: "/tmp" });
  });

  test("write MCP tool awaits approval before callTool", async () => {
    const { deps, callTool, requestMcpApproval } = createDeps();
    await executeMcpToolCall(
      { toolName: "mcp__fs__write_file", toolCallId: "tc2", input: { path: "/tmp/a" } },
      deps,
    );

    expect(requestMcpApproval).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  test("rejected write returns output-error without callTool", async () => {
    const requestMcpApproval = mock(() => Promise.resolve("reject" as const));
    const { deps, callTool, addToolOutput } = createDeps({ requestMcpApproval });
    await executeMcpToolCall(
      { toolName: "mcp__fs__write_file", toolCallId: "tc3", input: {} },
      deps,
    );

    expect(callTool).not.toHaveBeenCalled();
    expect(addToolOutput).toHaveBeenCalledWith(
      expect.objectContaining({ state: "output-error", toolCallId: "tc3" }),
    );
  });

  test("session allowlist skips repeat approval", async () => {
    const requestMcpApproval = mock(() => Promise.resolve("approve-once" as const));
    const sessionMcpAllowRef = new Set(["mcp__fs__write_file"]);
    const { deps, callTool, requestMcpApproval: req } = createDeps({
      requestMcpApproval,
      sessionMcpAllowRef,
    });
    await executeMcpToolCall(
      { toolName: "mcp__fs__write_file", toolCallId: "tc4", input: {} },
      deps,
    );

    expect(req).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  test("allow-session adds full mcp__ name to session allowlist", async () => {
    const requestMcpApproval = mock(() => Promise.resolve("allow-session" as const));
    const { deps, sessionMcpAllowRef } = createDeps({ requestMcpApproval });
    await executeMcpToolCall(
      { toolName: "mcp__fs__write_file", toolCallId: "tc5", input: {} },
      deps,
    );

    expect(sessionMcpAllowRef.has("mcp__fs__write_file")).toBe(true);
  });

  test("non-mcp tool returns false without side effects", async () => {
    const { deps } = createDeps();
    const handled = await executeMcpToolCall(
      { toolName: "bash", toolCallId: "tc6", input: {} },
      deps,
    );

    expect(handled).toBe(false);
  });

  test("mixed-case prefix preserves server segment for callTool", async () => {
    const { deps, callTool } = createDeps();
    await executeMcpToolCall(
      { toolName: "Mcp__MyServer__get_file", toolCallId: "tc7", input: { path: "/tmp" } },
      deps,
    );

    expect(callTool).toHaveBeenCalledWith("MyServer", "get_file", { path: "/tmp" });
  });
});
