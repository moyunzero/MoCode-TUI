/**
 * OS-level sandbox profiles and spawn plans.
 *
 * The path checks in `sandbox-path.ts` cannot contain a shell — this module is what
 * actually does. Given a backend, it produces either an SBPL profile (macOS) or a
 * bubblewrap argument list (Linux), plus the exact argv to spawn.
 *
 * Everything here is a pure function on purpose: a sandbox whose profile is wrong
 * fails silently in the worst possible direction, so the profile is asserted in
 * tests rather than eyeballed in production.
 *
 * Policy: **deny by default, then allow what a shell needs, then deny secrets.**
 * On modern macOS a narrow read-allowlist SIGABRTs (dyld/cryptex paths), so reads
 * are allowed under `/` and sensitive trees are denied afterward. Writes stay
 * limited to the project and tmp.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";

/** Sandbox binaries are addressed absolutely: a bare name resolves against the
 * allowlisted env we hand the child, and a miss looks like "the sandbox broke". */
export const SEATBELT_BIN = "/usr/bin/sandbox-exec";
export const BWRAP_BIN = "/usr/bin/bwrap";

export type SandboxBackend = "seatbelt" | "bwrap" | "none";

export type SandboxProfileOptions = {
  /** Project root: the only tree that is writable. */
  cwd: string;
  /** Used for tmp paths and the extra allowlist defaults. */
  home?: string;
  tmpDir?: string;
  /** Additional read-only trees (colon-separated `MOCODE_SANDBOX_EXTRA_READ`). */
  extraReadPaths?: string[];
  /** Additional writable trees (`MOCODE_SANDBOX_EXTRA_WRITE`). */
  extraWritePaths?: string[];
  /** Runtime install dirs that must stay readable (bun/node themselves). */
  runtimePaths?: string[];
};

/** Escape a path for SBPL string literals. */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function uniq(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** Split a colon-separated env var into paths. */
export function parsePathList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(":")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Sensitive paths denied after the broad filesystem read allow.
 *
 * Mirrors the bwrap mask list so both backends refuse the same secret trees.
 */
function deniedReadPaths(home: string | undefined): string[] {
  const system = [
    "/etc/passwd",
    "/etc/shadow",
    "/etc/sudoers",
    "/private/etc/passwd",
    "/private/etc/shadow",
    "/private/etc/sudoers",
    "/var/root",
    "/root",
  ];
  const user = home
    ? [
        `${home}/.ssh`,
        `${home}/.aws`,
        `${home}/.gnupg`,
        `${home}/.config/gh`,
        `${home}/.config/gcloud`,
        `${home}/.kube`,
        `${home}/.docker`,
        // Package-manager config routinely carries registry tokens.
        `${home}/.npmrc`,
        `${home}/.yarnrc`,
        `${home}/.pypirc`,
        `${home}/.netrc`,
      ]
    : [];
  return uniq([...system, ...user]);
}

/**
 * Build the macOS seatbelt profile.
 *
 * `(deny default)` first. Broad `(allow file-read* (subpath "/"))` is required on
 * current macOS — a narrow subpath allowlist aborts the child before it starts.
 * Sensitive paths are denied afterward (later SBPL rules win for the same op).
 * Writes stay limited to the project / tmp.
 */
export function buildSeatbeltProfile(options: SandboxProfileOptions): string {
  const { cwd } = options;
  const writePaths = uniq([
    cwd,
    ...(options.tmpDir ? [options.tmpDir] : []),
    ...(options.extraWritePaths ?? []),
    "/dev/null",
    "/dev/tty",
  ]);
  const denied = deniedReadPaths(options.home);

  const writeRules = writePaths.map((path) => `(subpath ${sbplString(path)})`).join(" ");
  const denyRules = denied.map((path) => `(subpath ${sbplString(path)})`).join(" ");

  return [
    "(version 1)",
    "(deny default)",
    // Process control is required by any shell.
    "(allow process*)",
    "(allow signal)",
    "(allow sysctl-read)",
    // Lookups for system services; keep to the operation names that have been
    // stable across macOS releases. An unknown operation makes `sandbox_apply`
    // fail as a whole, which shows up as "the command produced no output".
    "(allow mach-lookup)",
    "(allow file-read-metadata)",
    // Broad read: narrow allowlists SIGABRT on dyld/cryptex hosts.
    '(allow file-read* (subpath "/"))',
    // Executables must be mappable, otherwise the dynamic loader fails.
    "(allow file-map-executable)",
    `(allow file-write* ${writeRules})`,
    "(allow network*)",
    // Later rules win — block the secret trees after the broad allow.
    `(deny file-read* ${denyRules})`,
  ].join("\n");
}

/**
 * Masked paths are bound to `/dev/null` so the sandbox cannot read them even
 * though bwrap's default is a full read-only filesystem view.
 */
const BWRAP_MASKED_FILES = [
  "/etc/shadow",
  "/etc/sudoers",
  ".netrc",
  ".npmrc",
  ".yarnrc",
  ".pypirc",
] as const;

/** Directories need an empty dir, not a file bind: binding a file over a
 * directory makes bubblewrap refuse to start. */
const BWRAP_MASKED_DIRS = [".ssh", ".aws", ".gnupg", ".config/gh", ".config/gcloud", ".kube", ".docker"] as const;

/**
 * Build the bubblewrap argument list.
 *
 * bwrap cannot express "deny by default" without rebuilding the whole root, so the
 * approach is: read-only root, writable project, and sensitive paths masked.
 */
export function buildBwrapArgs(options: SandboxProfileOptions): string[] {
  const { cwd } = options;
  const args = [
    "--die-with-parent",
    "--ro-bind",
    "/",
    "/",
    "--bind",
    cwd,
    cwd,
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--chdir",
    cwd,
  ];

  for (const extra of options.extraWritePaths ?? []) {
    args.push("--bind", extra, extra);
  }

  for (const masked of BWRAP_MASKED_FILES) {
    const path = masked.startsWith("/") ? masked : options.home ? `${options.home}/${masked}` : null;
    if (path && existsSync(path)) args.push("--ro-bind", "/dev/null", path);
  }

  // Absent dirs are skipped: bwrap fails the whole sandbox if a target is missing.
  for (const masked of BWRAP_MASKED_DIRS) {
    const path = masked.startsWith("/") ? masked : options.home ? `${options.home}/${masked}` : null;
    if (path && existsSync(path)) args.push("--tmpfs", path);
  }

  // Private scratch space: without this, TMPDIR points at a read-only host path.
  args.push("--tmpfs", "/tmp");

  return args;
}

export type SpawnPlan = {
  file: string;
  args: string[];
  /** Recorded in the audit log so "confined" is provable after the fact. */
  confined: boolean;
  backend: SandboxBackend;
};

/**
 * Decide how to spawn a shell command.
 *
 * `none` is the honest fallback: the caller still gets a working shell, and the
 * approval policy stays fail-closed because `confined` is false.
 */
export function spawnPlan(
  backend: SandboxBackend,
  command: string,
  options: SandboxProfileOptions,
): SpawnPlan {
  if (backend === "seatbelt") {
    return {
      // Absolute path on purpose: `Bun.spawn` resolves a bare name against the env
      // it is given, and we hand it an allowlisted env. A resolution miss looks
      // exactly like "the sandbox broke" (exit null, empty output).
      file: SEATBELT_BIN,
      args: ["-p", buildSeatbeltProfile(options), "bash", "-c", command],
      confined: true,
      backend,
    };
  }

  if (backend === "bwrap") {
    return {
      file: BWRAP_BIN,
      args: [...buildBwrapArgs(options), "bash", "-c", command],
      confined: true,
      backend,
    };
  }

  return { file: "bash", args: ["-c", command], confined: false, backend: "none" };
}

/** Runtime dirs that must stay readable so `bun`/`node` can start inside the sandbox. */
export function runtimePaths(execPath: string = process.execPath): string[] {
  return uniq([dirname(execPath)]);
}
