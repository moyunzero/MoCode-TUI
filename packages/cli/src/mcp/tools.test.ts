import { describe, expect, test } from "bun:test";
import { mcpToolName, buildMcpToolSet } from "./tools";
import { Mode } from "@mocode/shared";

describe("mcpToolName", () => {
  test("formats tool name as mcp__server__tool per D-05", () => {
    expect(mcpToolName("filesystem", "read_file")).toBe("mcp__filesystem__read_file");
  });

  test("preserves server and tool segments", () => {
    expect(mcpToolName("my-server", "list_items")).toBe("mcp__my-server__list_items");
  });
});

describe("buildMcpToolSet", () => {
  test("builds tool set with mcp__ naming prefix", () => {
    const tools = buildMcpToolSet(Mode.BUILD, [
      { serverName: "filesystem", tool: { name: "read_file", description: "Read a file", inputSchema: {} } },
    ]);

    expect(Object.keys(tools)).toContain("mcp__filesystem__read_file");
  });

  test("PLAN mode excludes write MCP tools", () => {
    const tools = buildMcpToolSet(Mode.PLAN, [
      { serverName: "filesystem", tool: { name: "read_file", description: "Read", inputSchema: {} } },
      { serverName: "filesystem", tool: { name: "write_file", description: "Write", inputSchema: {} } },
    ]);

    expect(Object.keys(tools)).toContain("mcp__filesystem__read_file");
    expect(Object.keys(tools)).not.toContain("mcp__filesystem__write_file");
  });
});
