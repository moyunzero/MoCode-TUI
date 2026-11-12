/**
 * Audit + structured refusal codes.
 *
 * Enterprise rule: the executor is the authority, so every decision must be
 * recordable. These tests assert on the *log*, not on the error message — a
 * refusal nobody can audit is indistinguishable from a bug.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mode } from "@mocode/shared";
import { executeLocalTool } from "./local-tools";
import { ToolPermissionError } from "./permission-rules";

const dir = mkdtempSync(join(tmpdir(), "mocode-tool-audit-"));
const logPath = join(dir, "audit.jsonl");

beforeAll(() => {
  process.env.MOCODE_AUDIT_PATH = logPath;
});

afterAll(() => {
  delete process.env.MOCODE_AUDIT_PATH;
  rmSync(dir, { recursive: true, force: true });
});

function entries(): Array<Record<string, unknown>> {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Run a call that is expected to be refused and return the thrown error. */
async function refused(
  tool: string,
  input: unknown,
  mode: (typeof Mode)[keyof typeof Mode] = Mode.BUILD,
): Promise<ToolPermissionError> {
  try {
    await executeLocalTool(tool, input, mode);
  } catch (error) {
    expect(error).toBeInstanceOf(ToolPermissionError);
    return error as ToolPermissionError;
  }

  throw new Error(`expected ${tool} to be refused`);
}

describe("structured refusal codes", () => {
  test("path escape carries PATH_ESCAPE", async () => {
    const error = await refused("readFile", { path: "/etc/passwd" });
    expect(error.code).toBe("PATH_ESCAPE");
  });

  test("hard deny carries HARD_DENY", async () => {
    const error = await refused("bash", { command: "mkfs.ext4 /dev/null" });
    expect(error.code).toBe("HARD_DENY");
  });

  test("plan mode carries MODE_DENIED", async () => {
    const error = await refused("writeFile", { path: "a.txt", content: "x" }, Mode.PLAN);
    expect(error.code).toBe("MODE_DENIED");
  });

  test("unknown tool carries UNKNOWN_TOOL", async () => {
    const error = await refused("rmMinusRf", { path: "x" });
    expect(error.code).toBe("UNKNOWN_TOOL");
  });

  test("the message stays readable for the model", async () => {
    const error = await refused("readFile", { path: "/etc/passwd" });
    expect(error.message).toContain("outside the project directory");
  });
});

describe("audit trail", () => {
  test("a successful call is logged as ok", async () => {
    await executeLocalTool("listDirectory", { path: "." }, Mode.BUILD);
    const entry = entries().at(-1);

    expect(entry).toMatchObject({ tool: "listDirectory", mode: "BUILD", outcome: "ok" });
  });

  test("a refusal is logged with its code — not silently dropped", async () => {
    await refused("readFile", { path: "../../etc/passwd" });
    const entry = entries().at(-1);

    expect(entry).toMatchObject({
      tool: "readFile",
      outcome: "denied",
      code: "PATH_ESCAPE",
    });
  });

  test("a non-permission failure is logged as error without a code", async () => {
    await expect(
      executeLocalTool("readFile", { path: "definitely-missing.txt" }, Mode.BUILD),
    ).rejects.toThrow();

    const entry = entries().at(-1);
    expect(entry).toMatchObject({ tool: "readFile", outcome: "error" });
    expect(entry?.code).toBeUndefined();
  });

  test("file contents never reach the log", async () => {
    const secret = "TOP-SECRET-PAYLOAD-" + "y".repeat(500);

    // Refused on purpose: the write must not happen, yet the attempt is logged —
    // proving the summary is built from the input without echoing it.
    await refused("writeFile", { path: "/etc/audit-probe.txt", content: secret });

    const raw = readFileSync(logPath, "utf8");
    expect(raw).not.toContain("TOP-SECRET-PAYLOAD");
    expect(raw).toContain("writeFile");
  });

  test("every decision produces exactly one line", async () => {
    const before = entries().length;

    await executeLocalTool("listDirectory", { path: "." }, Mode.BUILD);
    await refused("readFile", { path: "/etc/passwd" });

    expect(entries().length).toBe(before + 2);
  });
});
