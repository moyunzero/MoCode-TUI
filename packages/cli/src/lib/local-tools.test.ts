import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Mode } from "@mocode/shared";
import { executeLocalTool } from "./local-tools";

const originalCwd = process.cwd();
let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    process.chdir(originalCwd);
    tempDir = null;
  }
});

function withTempProject(run: (projectDir: string) => Promise<void>): Promise<void> {
  tempDir = mkdtempSync(join(tmpdir(), "mocode-local-tools-"));
  process.chdir(tempDir);
  return run(tempDir);
}

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

  test("rejects line_start greater than line_end", async () => {
    await expect(
      executeLocalTool("readFile", { path: "package.json", line_start: 10, line_end: 1 }, Mode.PLAN),
    ).rejects.toThrow(/line_start must be less than or equal to line_end/);
  });

  test("reads line_start through EOF when line_end is omitted", async () => {
    await withTempProject(async () => {
      writeFileSync("sample.txt", "alpha\nbeta\ngamma\n", "utf-8");

      const result = (await executeLocalTool(
        "readFile",
        { path: "sample.txt", line_start: 2 },
        Mode.PLAN,
      )) as { content: string };

      expect(result.content).toBe("beta\ngamma");
    });
  });

  test("streams only the requested line range from a large file", async () => {
    await withTempProject(async () => {
      const lines = Array.from({ length: 5_000 }, (_, index) => `line-${index + 1}`);
      writeFileSync("large.txt", `${lines.join("\n")}\n`, "utf-8");

      const result = (await executeLocalTool(
        "readFile",
        { path: "large.txt", line_start: 100, line_end: 102 },
        Mode.PLAN,
      )) as { content: string };

      expect(result.content).toBe("line-100\nline-101\nline-102");
    });
  });

  test("truncates full-file reads at MAX_FILE_SIZE without loading beyond limit", async () => {
    await withTempProject(async () => {
      writeFileSync("huge.txt", "x".repeat(12_000), "utf-8");

      const result = (await executeLocalTool(
        "readFile",
        { path: "huge.txt" },
        Mode.PLAN,
      )) as { content: string; truncated?: boolean };

      expect(result.content).toHaveLength(10_000);
      expect(result.truncated).toBe(true);
    });
  });

  test("truncates line-range reads when selected range exceeds MAX_FILE_SIZE", async () => {
    await withTempProject(async () => {
      mkdirSync("nested", { recursive: true });
      writeFileSync(join("nested", "wide.txt"), `${"y".repeat(12_000)}\n`, "utf-8");

      const result = (await executeLocalTool(
        "readFile",
        { path: "nested/wide.txt", line_start: 1, line_end: 1 },
        Mode.PLAN,
      )) as { content: string; truncated?: boolean; totalLength?: number };

      expect(result.content).toHaveLength(10_000);
      expect(result.truncated).toBe(true);
      expect(result.totalLength).toBe(12_000);
    });
  });
});
