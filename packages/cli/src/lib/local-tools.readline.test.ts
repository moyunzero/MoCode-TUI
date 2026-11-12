/**
 * `readLinesFromFile` length accounting.
 *
 * A range whose first selected line is empty used to undercount by one: the code
 * treated `selectedLength === 0` as "nothing selected yet", so the *second* line
 * skipped its separator. Length is not a proxy for selection.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mode } from "@mocode/shared";
import { executeLocalTool } from "./local-tools";

const dir = mkdtempSync(join(tmpdir(), "mocode-readline-"));
const originalCwd = process.cwd();

// First line empty, then a body long enough to force truncation metadata.
const secondLine = "y".repeat(12_000);
const filePath = "big.txt";
writeFileSync(join(dir, filePath), `\n${secondLine}\n`);

beforeAll(() => {
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("readLinesFromFile", () => {
  test("counts the separator even when the first selected line is empty", async () => {
    const result = (await executeLocalTool(
      "readFile",
      { path: filePath, line_start: 1, line_end: 2 },
      Mode.BUILD,
    )) as { content: string; truncated?: boolean; totalLength?: number };

    expect(result.truncated).toBe(true);
    // "" + "\n" + secondLine
    expect(result.totalLength).toBe(secondLine.length + 1);
  });

  test("keeps the truncation budget aligned with the counted length", async () => {
    const result = (await executeLocalTool(
      "readFile",
      { path: filePath, line_start: 1, line_end: 2 },
      Mode.BUILD,
    )) as { content: string; truncated?: boolean };

    // 10_000 char budget: the empty first line must not silently buy an extra cell.
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(10_000);
  });
});
