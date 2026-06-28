import { describe, expect, test } from "bun:test";
import { isMcpReadOnlyTool, isMcpToolName, looksLikeMcpToolName, normalizeMcpToolName, requiresMcpWriteApproval } from "./heuristics";

describe("isMcpToolName", () => {
  test("accepts canonical mcp__server__tool names", () => {
    expect(isMcpToolName("mcp__filesystem__read_file")).toBe(true);
  });

  test("rejects malformed names", () => {
    expect(isMcpToolName("mcp__bad")).toBe(false);
    expect(isMcpToolName("bash")).toBe(false);
  });

  test("looksLikeMcpToolName accepts mixed-case prefix", () => {
    expect(looksLikeMcpToolName("Mcp__filesystem__read_file")).toBe(true);
    expect(looksLikeMcpToolName("mcp__filesystem__read_file")).toBe(true);
  });
});

describe("normalizeMcpToolName", () => {
  test("lowercases prefix only and preserves server casing", () => {
    expect(normalizeMcpToolName("Mcp__FileSystem__read_file")).toBe(
      "mcp__FileSystem__read_file",
    );
  });

  test("leaves canonical names unchanged", () => {
    expect(normalizeMcpToolName("mcp__filesystem__read_file")).toBe(
      "mcp__filesystem__read_file",
    );
  });
});

describe("isMcpReadOnlyTool", () => {
  const readOnlyTools = [
    { name: "get_foo", tool: "get_foo" },
    { name: "list_items", tool: "list_items" },
    { name: "read_file", tool: "read_file" },
    { name: "fetch_data", tool: "fetch_data" },
    { name: "search_docs", tool: "search_docs" },
  ];

  test.each(readOnlyTools)("$name is read-only", ({ tool }) => {
    expect(isMcpReadOnlyTool(tool)).toBe(true);
  });

  const writeTools = [
    { name: "write_file", tool: "write_file" },
    { name: "delete_item", tool: "delete_item" },
    { name: "create_record", tool: "create_record" },
    { name: "update_config", tool: "update_config" },
  ];

  test.each(writeTools)("$name is not read-only", ({ tool }) => {
    expect(isMcpReadOnlyTool(tool)).toBe(false);
  });

  test("list_items is PLAN-visible (read-only)", () => {
    expect(isMcpReadOnlyTool("list_items")).toBe(true);
  });

  test("delete_item is not PLAN-visible", () => {
    expect(isMcpReadOnlyTool("delete_item")).toBe(false);
  });

  test("config readOnly:true forces read-only on write tool", () => {
    expect(isMcpReadOnlyTool("write_file", { readOnly: true })).toBe(true);
  });

  test("config readOnly:false forces write on read prefix tool", () => {
    expect(isMcpReadOnlyTool("get_weather", { readOnly: false })).toBe(false);
  });
});

describe("requiresMcpWriteApproval", () => {
  const writeTools = [
    { name: "write_file", tool: "write_file" },
    { name: "delete_item", tool: "delete_item" },
    { name: "create_record", tool: "create_record" },
    { name: "update_config", tool: "update_config" },
    { name: "push_changes", tool: "push_changes" },
  ];

  test.each(writeTools)("$name requires write approval", ({ tool }) => {
    expect(requiresMcpWriteApproval(tool, new Set())).toBe(true);
  });

  test("get_foo does not require write approval", () => {
    expect(requiresMcpWriteApproval("get_foo", new Set())).toBe(false);
  });
});
