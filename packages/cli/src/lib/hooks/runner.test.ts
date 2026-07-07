import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runBeforeHook } from "./runner";

function writeExecutableScript(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

describe("runBeforeHook (D-36, D-38)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("exit code 0 allows tool execution", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mocode-hook-allow-"));
    tempDirs.push(dir);
    const script = writeExecutableScript(dir, "allow.sh", "#!/bin/sh\nexit 0\n");

    const result = await runBeforeHook({
      command: [script],
      payload: { toolName: "bash", input: { command: "echo hi" } },
      timeoutMs: 500,
    });

    expect(result.allowed).toBe(true);
  });

  test("exit code 1 blocks with reason from stderr (D-36)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mocode-hook-block-"));
    tempDirs.push(dir);
    const script = writeExecutableScript(
      dir,
      "block.sh",
      '#!/bin/sh\necho "policy violation" >&2\nexit 1\n',
    );

    const result = await runBeforeHook({
      command: [script],
      payload: { toolName: "bash", input: { command: "rm -rf /" } },
      timeoutMs: 500,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("policy violation");
  });

  test("timeout kills process and blocks (D-38)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mocode-hook-timeout-"));
    tempDirs.push(dir);
    const script = writeExecutableScript(dir, "slow.sh", "#!/bin/sh\nsleep 2\nexit 0\n");

    const result = await runBeforeHook({
      command: [script],
      payload: { toolName: "bash", input: { command: "sleep 2" } },
      timeoutMs: 30,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason?.toLowerCase()).toMatch(/timeout|timed out/i);
  });

  test("stdout JSON deny on exit 0 blocks tool (optional scaffold)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mocode-hook-json-deny-"));
    tempDirs.push(dir);
    const script = writeExecutableScript(
      dir,
      "json-deny.sh",
      '#!/bin/sh\necho \'{"allow":false,"reason":"denied by policy"}\'\nexit 0\n',
    );

    const result = await runBeforeHook({
      command: [script],
      payload: { toolName: "bash", input: { command: "echo test" } },
      timeoutMs: 500,
    });

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("denied by policy");
  });
});
