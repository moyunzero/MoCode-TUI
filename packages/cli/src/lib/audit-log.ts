/**
 * Append-only audit log for tool authorization decisions.
 *
 * Enterprise requirement, and the reason the executor — not the model — is the
 * authority: every call must leave a record of *what was attempted* and *what was
 * decided*, whether it ran or was refused. A refusal that nobody can audit is
 * indistinguishable from a bug.
 *
 * Design constraints:
 *
 * 1. **Never log file contents.** Only short, single-line scalar arguments are
 *    recorded, capped hard. An audit log that captures source code is a data leak
 *    with extra steps.
 * 2. **Never break a tool call.** Auditing is best-effort: a full disk or a
 *    read-only home must not turn a working tool into a failing one.
 * 3. **One line per decision, JSONL** — append-only and greppable, so `jq` and log
 *    shippers work without a parser.
 */
import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Owner-only directory mode for the audit trail. */
const AUDIT_DIR_MODE = 0o700;
/** Owner-only file mode for the active log and rotated archives. */
const AUDIT_FILE_MODE = 0o600;

/** Best-effort chmod — never fails the tool call that triggered the write. */
function ownerOnly(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Platform/umask may refuse; auditing remains best-effort.
  }
}

/** Rotate once the active file reaches this size. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
/** Archives kept alongside the active file (`audit.jsonl.1` … `.N`). */
const DEFAULT_MAX_FILES = 5;

export type AuditRotation = {
  maxBytes: number;
  maxFiles: number;
};

/** Read positive numbers from the environment, falling back to the defaults. */
function readPositive(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Rotation policy, overridable for tests and for long-lived agents. */
export function auditRotation(): AuditRotation {
  return {
    maxBytes: readPositive(process.env.MOCODE_AUDIT_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxFiles: readPositive(process.env.MOCODE_AUDIT_MAX_FILES, DEFAULT_MAX_FILES),
  };
}

function rotatedName(path: string, index: number): string {
  return `${path}.${index}`;
}

/**
 * Move the active file aside once it exceeds `maxBytes`.
 *
 * Archives are numbered newest-first (`.1` is the most recent) and the oldest is
 * dropped, so a chatty agent costs a bounded amount of disk and never grows the
 * log indefinitely. Returns `true` when a rotation happened.
 *
 * Best-effort like the rest of this module: a failed rotation leaves the file in
 * place and must not fail the tool call that triggered it.
 */
export function rotateIfNeeded(
  path: string = defaultAuditPath(),
  rotation: AuditRotation = auditRotation(),
): boolean {
  let size: number;

  try {
    size = statSync(path).size;
  } catch {
    // No file yet — nothing to rotate.
    return false;
  }

  if (size < rotation.maxBytes) return false;

  try {
    // Drop the oldest archive before shifting, so the chain never exceeds maxFiles.
    rmSync(rotatedName(path, rotation.maxFiles), { force: true });

    for (let index = rotation.maxFiles - 1; index >= 1; index -= 1) {
      try {
        const from = rotatedName(path, index);
        const to = rotatedName(path, index + 1);
        renameSync(from, to);
        ownerOnly(to, AUDIT_FILE_MODE);
      } catch {
        // That archive does not exist yet — fine.
      }
    }

    const archive = rotatedName(path, 1);
    renameSync(path, archive);
    ownerOnly(archive, AUDIT_FILE_MODE);
    return true;
  } catch {
    return false;
  }
}

export type AuditOutcome = "ok" | "denied" | "error";

export type AuditEvent = {
  /** ISO-8601, UTC. */
  timestamp: string;
  tool: string;
  mode: string;
  outcome: AuditOutcome;
  /** Machine-readable refusal code when `outcome` is `denied`. */
  code?: string;
  /** Short summary of the call — never full argument payloads. */
  /** For shell calls: whether an OS sandbox confined the child process. */
  shellConfined?: boolean;
  detail?: string;
};

/** Where decisions are appended. `MOCODE_AUDIT_PATH` exists for tests and CI. */
export function defaultAuditPath(): string {
  return process.env.MOCODE_AUDIT_PATH ?? join(homedir(), ".mocode", "audit.jsonl");
}

/** Longest single value kept in the log. */
const MAX_VALUE_LENGTH = 120;
/** Longest total summary kept in the log. */
const MAX_DETAIL_LENGTH = 240;
/**
 * Commands get their own, larger budget.
 *
 * Auditing a shell call without the command is pointless, and shell commands are
 * routinely multi-line. They are collapsed and truncated instead of dropped — the
 * cap still bounds how much of a heredoc can leak.
 */
const MAX_COMMAND_LENGTH = 160;

/**
 * Secrets that may appear *inside* a command.
 *
 * The audit needs the command to be reviewable, but a command is user-controlled
 * text and can carry credentials. Masking known shapes beats both extremes:
 * logging raw (leaks) and dropping the command (useless).
 */
const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/(\bsk-[A-Za-z0-9_-]{8,})/g, "sk-***"],
  [/(\bBearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, "$1***"],
  [/\b((?:[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=)(\S+)/g, "$1***"],
  [/(Authorization:\s*)\S+/gi, "$1***"],
  // Any header-ish `Name: value` where the name looks like a credential.
  [/([\w-]*(?:API[-_]?Key|ApiKey|Token|Secret|Password)[\w-]*\s*:\s*)[^\s"']+/gi, "$1***"],
];

/** Mask credential-shaped substrings before a command reaches the log. */
export function redactSecrets(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

/**
 * Explicitly approved string fields. Everything else — file bodies, credentials,
 * bash commands, edit payloads, free-form prompts — is omitted.
 */
const SAFE_STRING_KEYS = new Set([
  "path",
  "pattern",
  "include",
  "ref",
  "description",
  "subagent_type",
  // A shell audit entry without its command cannot be reviewed. It is collapsed
  // and capped rather than dropped — see MAX_COMMAND_LENGTH.
  "command",
]);

/**
 * Reduce tool input to a short, single-line summary of approved fields only.
 *
 * Strings longer than {@link MAX_VALUE_LENGTH} or containing newlines are dropped
 * entirely rather than truncated — a truncated file body is still file body.
 */
export function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";

  const parts: string[] = [];

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}=${value}`);
      continue;
    }

    if (typeof value !== "string" || !SAFE_STRING_KEYS.has(key)) continue;

    if (key === "command") {
      const collapsed = redactSecrets(value).replace(/\s+/g, " ").trim();
      if (collapsed) parts.push(`${key}=${collapsed.slice(0, MAX_COMMAND_LENGTH)}`);
      continue;
    }

    if (value.length <= MAX_VALUE_LENGTH && !value.includes("\n")) {
      parts.push(`${key}=${value}`);
    }
  }

  return parts.join(" ").slice(0, MAX_DETAIL_LENGTH);
}

/**
 * Append one decision. Returns `true` when written, `false` when the write was
 * skipped or failed — never throws.
 *
 * Rotation is checked immediately before the append, so the log is bounded from
 * the first write without a background worker.
 */
export function recordAudit(
  event: Omit<AuditEvent, "timestamp">,
  path: string = defaultAuditPath(),
): boolean {
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: AUDIT_DIR_MODE });
    ownerOnly(dir, AUDIT_DIR_MODE);
    rotateIfNeeded(path);
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...event });
    appendFileSync(path, `${line}\n`, { encoding: "utf8", mode: AUDIT_FILE_MODE });
    // Re-assert owner-only so a pre-existing world-readable file does not stay open.
    ownerOnly(path, AUDIT_FILE_MODE);
    return true;
  } catch {
    // Auditing is best-effort: losing a log line must never fail a tool call.
    return false;
  }
}
