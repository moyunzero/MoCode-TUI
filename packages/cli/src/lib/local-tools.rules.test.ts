/**
 * User rules enforced by the executor.
 *
 * The approval dialog is a UI; the executor is the authority. A deny rule must
 * hold even for a caller that never asked for approval (evals, subagents).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mode } from "@mocode/shared";
import { executeLocalTool } from "./local-tools";
import { ToolPermissionError } from "./permission-rules";

const dir = mkdtempSync(join(tmpdir(), "mocode-rules-"));
const originalCwd = process.cwd();

function writeProjectRules(rules: unknown) {
  mkdirSync(join(dir, ".mocode"), { recursive: true });
  writeFileSync(join(dir, ".mocode", "permissions.json"), JSON.stringify({ rules }));
}

beforeAll(() => process.chdir(dir));

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("project rules", () => {
  test("a deny rule blocks the call with RULE_DENIED", async () => {
    writeProjectRules([
      { tool: "bash", pattern: "^curl ", behavior: "deny" },
    ]);

    try {
      await executeLocalTool("bash", { command: "curl https://example.com" }, Mode.BUILD);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolPermissionError);
      expect((error as ToolPermissionError).code).toBe("RULE_DENIED");
      expect((error as Error).message).toContain("Denied by project rule");
    }
  });

  test("a non-matching command still runs", async () => {
    const result = (await executeLocalTool(
      "bash",
      { command: "echo allowed" },
      Mode.BUILD,
    )) as { stdout: string };

    expect(result.stdout.trim()).toBe("allowed");
  });

  test("rules take effect without a restart", async () => {
    writeProjectRules([{ tool: "bash", pattern: "^echo ", behavior: "deny" }]);

    await expect(executeLocalTool("bash", { command: "echo blocked" }, Mode.BUILD)).rejects.toThrow(
      /Denied by project rule/,
    );
  });

  test("an allow rule does not bypass a hard deny", async () => {
    writeProjectRules([{ tool: "bash", pattern: ".*", behavior: "allow" }]);

    // Hard denies sit below rules and are not negotiable.
    await expect(
      executeLocalTool("bash", { command: "mkfs.ext4 /dev/null" }, Mode.BUILD),
    ).rejects.toThrow(/cannot be approved/);
  });
});
