/**
 * Sandbox attack suite.
 *
 * Each case is an escape attempt that a model could plausibly emit. They assert on
 * the real `executeLocalTool` entry point — the same function the agent calls —
 * not on a helper, because the point is that the fence holds where it is used.
 *
 * Every command used here is harmless if a guard ever regresses: they either fail
 * to resolve, or write to `/dev/null`.
 */
import { describe, expect, test } from "bun:test";
import { Mode } from "@mocode/shared";
import { executeLocalTool } from "./local-tools";
import { isShellConfined } from "./sandbox-capability";

describe("path escapes are refused", () => {
  test("absolute path outside the project", async () => {
    await expect(
      executeLocalTool("readFile", { path: "/etc/passwd" }, Mode.BUILD),
    ).rejects.toThrow("Path is outside the project directory");
  });

  test("parent traversal", async () => {
    await expect(
      executeLocalTool("readFile", { path: "../../../../../../etc/passwd" }, Mode.BUILD),
    ).rejects.toThrow("Path is outside the project directory");
  });

  test("writing outside the project", async () => {
    await expect(
      executeLocalTool("writeFile", { path: "/tmp/mocode-escape-probe.txt", content: "x" }, Mode.BUILD),
    ).rejects.toThrow("Path is outside the project directory");
  });

  test("listing outside the project", async () => {
    await expect(
      executeLocalTool("listDirectory", { path: "/etc" }, Mode.BUILD),
    ).rejects.toThrow("Path is outside the project directory");
  });
});

describe("hard-denied commands are refused even after approval", () => {
  test("raw device write is refused at execution time", async () => {
    // Harmless if the guard regresses (writes to /dev/null), but it matches the rule.
    await expect(
      executeLocalTool("bash", { command: "dd if=/dev/zero of=/dev/null count=1" }, Mode.BUILD),
    ).rejects.toThrow("cannot be approved");
  });

  test("filesystem formatting is refused at execution time", async () => {
    await expect(
      executeLocalTool("bash", { command: "mkfs.ext4 /dev/null" }, Mode.BUILD),
    ).rejects.toThrow("cannot be approved");
  });
});

describe("the shell cannot read secret trees when confined", () => {
  // Host-dependent by nature: on a machine without seatbelt/bwrap the executor is
  // unconfined, and the control that applies there is per-command approval — not
  // this assertion. Declaring the precondition keeps the suite honest instead of
  // failing on CI hosts that cannot sandbox.
  test.skipIf(!isShellConfined())("reading /etc/passwd is refused by the OS sandbox", async () => {
    const result = (await executeLocalTool(
      "bash",
      { command: "head -1 /etc/passwd 2>&1; echo EXIT:$?" },
      Mode.BUILD,
    )) as { stdout: string };

    // Confined hosts deny the read; unconfined hosts still fail closed via approval,
    // but this suite runs the executor directly — assert the sandbox denial when present.
    expect(result.stdout).not.toMatch(/^[^:\n]+:[^:\n]*:[0-9]+:/);
    expect(result.stdout).toMatch(/Operation not permitted|Permission denied|EXIT:[1-9]/);
  });
});

describe("the shell does not inherit secrets", () => {
  test("an API key in the CLI process is not visible to the agent's shell", async () => {
    const canary = "sk-mocode-canary-should-not-leak";
    process.env.DEEPSEEK_API_KEY = canary;

    try {
      const result = (await executeLocalTool(
        "bash",
        { command: 'echo -n "${DEEPSEEK_API_KEY:-absent}"' },
        Mode.BUILD,
      )) as { stdout: string };

      expect(result.stdout).toBe("absent");
      expect(result.stdout).not.toContain(canary);
    } finally {
      delete process.env.DEEPSEEK_API_KEY;
    }
  });

  test("the shell still works — PATH is present", async () => {
    const result = (await executeLocalTool("bash", { command: "echo -n $PATH" }, Mode.BUILD)) as {
      stdout: string;
    };

    expect(result.stdout.length).toBeGreaterThan(0);
  });

  test("TERM is forced to dumb so escape codes never reach the TUI", async () => {
    const result = (await executeLocalTool("bash", { command: "echo -n $TERM" }, Mode.BUILD)) as {
      stdout: string;
    };

    expect(result.stdout).toBe("dumb");
  });
});

describe("plan mode is still read-only at the executor", () => {
  test("write tools are refused even if the server contract leaked through", async () => {
    await expect(
      executeLocalTool("writeFile", { path: "leak.txt", content: "x" }, Mode.PLAN),
    ).rejects.toThrow("not available in PLAN mode");
  });

  test("bash is refused", async () => {
    await expect(executeLocalTool("bash", { command: "echo hi" }, Mode.PLAN)).rejects.toThrow(
      "not available in PLAN mode",
    );
  });
});

describe("shell termination is reported with its real cause", () => {
  test("a timeout says timeout — not 'the sandbox failed'", async () => {
    await expect(
      executeLocalTool("bash", { command: "sleep 5", timeout: 150 }, Mode.BUILD),
    ).rejects.toThrow(/timed out/);
  });
});
