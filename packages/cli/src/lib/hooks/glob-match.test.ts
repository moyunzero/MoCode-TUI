import { describe, expect, test } from "bun:test";
import { matchesToolName } from "./glob-match";

describe("matchesToolName (D-35)", () => {
  test("exact match accepts bash", () => {
    expect(matchesToolName("bash", "bash")).toBe(true);
  });

  test("exact match rejects writeFile when matcher is bash", () => {
    expect(matchesToolName("writeFile", "bash")).toBe(false);
  });

  test("suffix glob mcp__* matches mcp__fs__read", () => {
    expect(matchesToolName("mcp__fs__read", "mcp__*")).toBe(true);
  });

  test("suffix glob mcp__* rejects writeFile", () => {
    expect(matchesToolName("writeFile", "mcp__*")).toBe(false);
  });

  test("glob does not match unrelated tool names", () => {
    expect(matchesToolName("readFile", "bash")).toBe(false);
    expect(matchesToolName("grep", "write*")).toBe(false);
  });
});
