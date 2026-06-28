import { describe, expect, test } from "bun:test";
import { requiresMcpWriteApproval } from "../mcp/heuristics";

const emptyAllowlist = new Set<string>();

describe("MCP write approval gate", () => {
  const writeTools = [
    { name: "write_file", tool: "write_file" },
    { name: "delete_item", tool: "delete_item" },
    { name: "create_record", tool: "create_record" },
    { name: "update_config", tool: "update_config" },
  ];

  test.each(writeTools)("$name triggers write approval requirement", ({ tool }) => {
    expect(requiresMcpWriteApproval(tool, emptyAllowlist)).toBe(true);
  });

  test("read-only tools do not trigger write approval", () => {
    expect(requiresMcpWriteApproval("get_foo", emptyAllowlist)).toBe(false);
    expect(requiresMcpWriteApproval("list_items", emptyAllowlist)).toBe(false);
    expect(requiresMcpWriteApproval("read_file", emptyAllowlist)).toBe(false);
  });

  test("session allowlist skips approval for full mcp__server__tool key", () => {
    const allowlist = new Set(["mcp__filesystem__write_file"]);
    expect(requiresMcpWriteApproval("mcp__filesystem__write_file", allowlist)).toBe(false);
    expect(requiresMcpWriteApproval("mcp__filesystem__write_file", emptyAllowlist)).toBe(true);
  });
});
