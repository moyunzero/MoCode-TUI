import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EVAL_CASES, type EvalCase } from "./cases";

const created: string[] = [];

/** Write a case's starting state into a throwaway directory. */
function materialize(evalCase: EvalCase): string {
  const dir = mkdtempSync(join(tmpdir(), `mocode-eval-${evalCase.id}-`));
  created.push(dir);

  for (const [path, content] of Object.entries(evalCase.files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  return dir;
}

function runCheck(dir: string, command: string) {
  return Bun.spawnSync(["bash", "-c", command], { cwd: dir, stdout: "pipe", stderr: "pipe" });
}

afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

describe("eval case registry", () => {
  test("ids are unique", () => {
    const ids = EVAL_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every case declares a prompt, files and a check", () => {
    for (const evalCase of EVAL_CASES) {
      expect(evalCase.prompt.length).toBeGreaterThan(20);
      expect(Object.keys(evalCase.files).length).toBeGreaterThan(0);
      expect(evalCase.check.length).toBeGreaterThan(0);
    }
  });

  test("each case ships a verifier, not just a source file", () => {
    for (const evalCase of EVAL_CASES) {
      expect(Object.keys(evalCase.files)).toContain("verify.ts");
    }
  });
});

describe("every case actually measures something", () => {
  // This is the most important test in the suite: a case whose check already
  // passes before the agent runs contributes nothing but a false success rate.
  for (const evalCase of EVAL_CASES) {
    test(`${evalCase.id} fails in its initial state`, () => {
      const dir = materialize(evalCase);
      const result = runCheck(dir, evalCase.check);

      expect(result.exitCode).not.toBe(0);
    });
  }

  // A check that passes on a syntactically broken project would be scoring
  // "did not crash" rather than "did the work".
  for (const evalCase of EVAL_CASES) {
    test(`${evalCase.id} check is runnable (not a missing binary)`, () => {
      const dir = materialize(evalCase);
      const result = runCheck(dir, evalCase.check);
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;

      expect(output).not.toContain("command not found");
    });
  }
});
