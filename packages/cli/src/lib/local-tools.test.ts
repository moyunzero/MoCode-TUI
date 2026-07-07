import { describe, expect, test } from "bun:test";
import { Mode } from "@mocode/shared";
import { executeLocalTool } from "./local-tools";

describe("executeLocalTool PLAN mode guards", () => {
  test("gitStatus succeeds in PLAN mode", async () => {
    await expect(executeLocalTool("gitStatus", {}, Mode.PLAN)).resolves.toBeDefined();
  });

  test("bash throws in PLAN mode", async () => {
    await expect(executeLocalTool("bash", { command: "echo hi" }, Mode.PLAN)).rejects.toThrow(
      /not available in PLAN mode/,
    );
  });
});

describe("executeLocalTool readFile", () => {
  test("accepts optional line_start and line_end for partial reads", async () => {
    const result = (await executeLocalTool(
      "readFile",
      { path: "package.json", line_start: 1, line_end: 1 },
      Mode.PLAN,
    )) as { content: string };

    expect(result.content).toBe("{");
  });
});
