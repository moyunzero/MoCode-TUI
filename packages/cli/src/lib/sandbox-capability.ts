/**
 * Shell sandbox capability probe.
 *
 * Why this exists: path containment (`sandbox-path.ts`) only guards the file
 * tools. A shell cannot be contained by path checks — `head /etc/passwd`,
 * `cat link-to-etc`, `cd ..` all escape anything enforced in-process. The only
 * real boundary is an OS-level sandbox.
 *
 * So the question is not "should bash be sandboxed" but "is this machine even
 * capable of it". This module answers that once, at first use, and the rest of the
 * system fails closed when the answer is no.
 *
 * Probes are injectable so tests do not depend on the host kernel.
 */

import { BWRAP_BIN, SEATBELT_BIN } from "./sandbox-profile";

export type SandboxBackend = "seatbelt" | "bwrap" | "none";

export type SandboxCapability = {
  backend: SandboxBackend;
  /** The host *can* apply a sandbox (a probe actually ran successfully). */
  available: boolean;
  /**
   * The executor *does* apply it to spawned shells.
   *
   * Capability is not enforcement — reporting `available` as if it were confined
   * is exactly the class of bug this whole module exists to prevent. Until the
   * spawn site wraps the profile, every backend reports `enforced: false` and the
   * approval policy stays fail-closed.
   */
  enforced: boolean;
  /** Why it is unavailable — surfaced in audit and diagnostics. */
  detail: string;
};

/** Runs a command and reports the exit code; split out so tests can fake it. */
export type ProbeRunner = (command: string[]) => { exitCode: number; output: string };

const defaultRunner: ProbeRunner = (command) => {
  try {
    const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: result.exitCode ?? 1,
      output: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
    };
  } catch (error) {
    return { exitCode: 1, output: error instanceof Error ? error.message : "probe failed" };
  }
};

/**
 * Deny-default probe that mirrors the production seatbelt shape.
 *
 * `(allow default)` is too weak: it succeeds on hosts where the real
 * deny-default profile SIGABRTs. Probe with deny-default + the broad read
 * allow that modern macOS needs, so "available" means spawn will work.
 */
const SEATBELT_PROBE_PROFILE = [
  "(version 1)",
  "(deny default)",
  "(allow process*)",
  "(allow sysctl-read)",
  "(allow mach-lookup)",
  '(allow file-read* (subpath "/"))',
  "(allow file-map-executable)",
].join("");

/**
 * macOS: `sandbox-exec` may exist yet fail to apply (nested sandbox, hardened
 * runtime, SIP). Existence is not capability — we must run a deny-default profile.
 */
export function probeSeatbelt(run: ProbeRunner = defaultRunner): SandboxCapability {
  const probe = run(["sandbox-exec", "-p", SEATBELT_PROBE_PROFILE, "/usr/bin/true"]);

  if (probe.exitCode === 0) {
    return {
      backend: "seatbelt",
      available: true,
      enforced: true,
      detail: "sandbox-exec applies; profile applied at spawn",
    };
  }

  return {
    backend: "seatbelt",
    available: false,
    enforced: false,
    detail: probe.output.slice(0, 120) || "sandbox-exec present but could not apply",
  };
}

/** Linux: bubblewrap is the portable answer; a failed bind mount means no capability. */
export function probeBwrap(run: ProbeRunner = defaultRunner): SandboxCapability {
  const probe = run([BWRAP_BIN, "--ro-bind", "/", "/", "--dev", "/dev", "true"]);

  if (probe.exitCode === 0) {
    return { backend: "bwrap", available: true, enforced: true, detail: "bwrap applies; profile applied at spawn" };
  }

  return {
    backend: "bwrap",
    available: false,
    enforced: false,
    detail: probe.output.slice(0, 120) || "bwrap unavailable",
  };
}

/** Detect the platform's backend without caching. */
export function detectSandbox(run: ProbeRunner = defaultRunner): SandboxCapability {
  if (process.platform === "darwin") return probeSeatbelt(run);
  if (process.platform === "linux") return probeBwrap(run);

  return {
    backend: "none",
    available: false,
    enforced: false,
    detail: `no sandbox backend on ${process.platform}`,
  };
}

let cached: SandboxCapability | null = null;

/**
 * Cached capability for the process.
 *
 * An explicit opt-out exists because failing closed is heavy: when no sandbox is
 * available every bash command needs approval. `MOCODE_ALLOW_UNCONFINED_SHELL=1`
 * accepts that risk knowingly rather than silently.
 */
export function sandboxCapability(): SandboxCapability {
  if (cached) return cached;

  if (process.env.MOCODE_ALLOW_UNCONFINED_SHELL === "1") {
    cached = { backend: "none", available: false, enforced: false, detail: "unconfined shell allowed by env" };
    return cached;
  }

  cached = detectSandbox();
  return cached;
}

/**
 * True only when a spawned shell is *actually* contained.
 *
 * Deliberately `available && enforced`: a host that can sandbox but whose spawn
 * site does not wrap the profile is still unconfined.
 */
export function isShellConfined(): boolean {
  // Must be derived from what the spawn site will actually do, not from what the
  // host *can* do: `MOCODE_DISABLE_SANDBOX=1` turns confinement off without
  // changing the probe result, and an unconfined shell must never be reported as
  // confined — the approval policy keys off this.
  return sandboxBackend() !== "none";
}

/**
 * Backend the spawn site should use right now, or `none`.
 *
 * `MOCODE_DISABLE_SANDBOX=1` exists for environments where seatbelt/bwrap breaks
 * legitimate work; it turns confinement off *and* leaves the approval policy
 * fail-closed, because `isShellConfined()` then reports false.
 */
export function sandboxBackend(): SandboxBackend {
  if (process.env.MOCODE_DISABLE_SANDBOX === "1") return "none";

  const capability = sandboxCapability();
  return capability.available && capability.enforced ? capability.backend : "none";
}

/** Test seam: forget the memoised probe. */
export function resetSandboxCapability(): void {
  cached = null;
}
