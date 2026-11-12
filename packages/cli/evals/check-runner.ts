/**
 * Bounded, credential-free check runner for evals.
 *
 * Two problems this solves, both found in review:
 *
 * 1. **A hanging check hangs the whole run.** `Bun.spawnSync` has no timeout, so
 *    one stuck command (e.g. a test that binds a port) blocks every remaining case
 *    and the report never gets written.
 * 2. **Checks inherited the full environment**, including provider credentials —
 *    and `verify.ts` is agent-writable, so a generated check could print them.
 *
 * The runner bounds each check, reports a timeout as a failure, and runs with the
 * same allowlisted environment the sandboxed tools get.
 */
import { buildSandboxEnv } from "../src/lib/permission-rules";

export type CheckResult = {
  ok: boolean;
  exitCode: number | null;
  signal: string | number | null;
  output: string;
  timedOut: boolean;
};

/** Per-check wall clock budget. Generous enough for `bun test`, short enough to bound a run. */
export const DEFAULT_CHECK_TIMEOUT_MS = 120_000;

export type CheckOptions = {
  timeoutMs?: number;
  /** Overrides the default allowlisted env (tests pass a minimal set). */
  env?: Record<string, string | undefined>;
};

/**
 * Run `command` in `cwd`, bounded by a deadline.
 *
 * On timeout the child is killed and the result is reported as a failure, so the
 * caller can record it and continue with the next case.
 */
export async function runCheck(
  cwd: string,
  command: string,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const env = (options.env ?? buildSandboxEnv()) as Record<string, string>;

  const proc = Bun.spawn(["bash", "-c", command], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      signal: proc.signalCode ?? null,
      output: `${stdout}${stderr}`.trim(),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
}
