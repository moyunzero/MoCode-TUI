import { describe, expect, test } from "bun:test";
import { buildSubagentToolSet } from "./tool-set";

const mockMcpTools = [
  { name: "mcp__filesystem__read_file", description: "Read file", inputSchema: {} },
  { name: "mcp__filesystem__write_file", description: "Write file", inputSchema: {} },
  { name: "mcp__db__list_items", description: "List items", inputSchema: {} },
];

describe("buildSubagentToolSet (D-05, D-14, D-15)", () => {
  test("explore set excludes task tool (D-05)", () => {
    const tools = buildSubagentToolSet("explore", { mcpTools: mockMcpTools });
    expect(Object.keys(tools)).not.toContain("task");
  });

  test("plan-research set excludes task tool (D-05)", () => {
    const tools = buildSubagentToolSet("plan-research", { mcpTools: mockMcpTools });
    expect(Object.keys(tools)).not.toContain("task");
  });

  test("plan-research excludes bash, write tools, and all MCP tools (D-15)", () => {
    const tools = buildSubagentToolSet("plan-research", { mcpTools: mockMcpTools });
    const names = Object.keys(tools);

    expect(names).not.toContain("bash");
    expect(names).not.toContain("writeFile");
    expect(names).not.toContain("editFile");
    for (const name of names) {
      expect(name).not.toMatch(/^mcp__/);
    }
    expect(names).toContain("readFile");
    expect(names).toContain("gitStatus");
  });

  test("explore includes read-only local tools and read-only MCP filter (D-14)", () => {
    const tools = buildSubagentToolSet("explore", { mcpTools: mockMcpTools });
    const names = Object.keys(tools);

    expect(names).toContain("readFile");
    expect(names).toContain("glob");
    expect(names).toContain("mcp__filesystem__read_file");
    expect(names).toContain("mcp__db__list_items");
    expect(names).not.toContain("mcp__filesystem__write_file");
  });
});
