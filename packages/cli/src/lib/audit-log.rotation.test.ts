/**
 * Audit log rotation.
 *
 * Without rotation a long-lived agent grows `audit.jsonl` without bound — the
 * audit trail becomes the outage. These tests pin the two properties that matter:
 * the file stays under the limit, and the archive count stays fixed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditRotation, recordAudit, rotateIfNeeded } from "./audit-log";

const dir = mkdtempSync(join(tmpdir(), "mocode-audit-rotate-"));
const logPath = join(dir, "audit.jsonl");

beforeAll(() => {
  process.env.MOCODE_AUDIT_PATH = logPath;
  // Tiny limits so a handful of entries trigger rotation.
  process.env.MOCODE_AUDIT_MAX_BYTES = "400";
  process.env.MOCODE_AUDIT_MAX_FILES = "2";
});

afterEach(() => {
  for (let index = 0; index <= 4; index += 1) {
    rmSync(`${logPath}.${index}`, { force: true });
  }
  rmSync(logPath, { force: true });
});

afterAll(() => {
  delete process.env.MOCODE_AUDIT_PATH;
  delete process.env.MOCODE_AUDIT_MAX_BYTES;
  delete process.env.MOCODE_AUDIT_MAX_FILES;
  rmSync(dir, { recursive: true, force: true });
});

function write(count: number) {
  for (let index = 0; index < count; index += 1) {
    recordAudit({ tool: "bash", mode: "BUILD", outcome: "ok", detail: `n=${index}` });
  }
}

describe("policy", () => {
  test("defaults are read from the environment when set", () => {
    expect(auditRotation()).toEqual({ maxBytes: 400, maxFiles: 2 });
  });

  test("invalid values fall back to the defaults, never to zero", () => {
    process.env.MOCODE_AUDIT_MAX_BYTES = "nonsense";
    process.env.MOCODE_AUDIT_MAX_FILES = "-3";
    try {
      const rotation = auditRotation();
      expect(rotation.maxBytes).toBeGreaterThan(0);
      expect(rotation.maxFiles).toBeGreaterThan(0);
    } finally {
      process.env.MOCODE_AUDIT_MAX_BYTES = "400";
      process.env.MOCODE_AUDIT_MAX_FILES = "2";
    }
  });
});

describe("rotation", () => {
  test("does nothing while the file is under the limit", () => {
    writeFileSync(logPath, "x".repeat(50));

    expect(rotateIfNeeded(logPath)).toBe(false);
    expect(existsSync(`${logPath}.1`)).toBe(false);
  });

  test("moves the file aside once it reaches the limit", () => {
    writeFileSync(logPath, "x".repeat(600));

    expect(rotateIfNeeded(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(existsSync(logPath)).toBe(false);
  });

  test("returns false when there is no file yet", () => {
    expect(rotateIfNeeded(logPath)).toBe(false);
  });

  test("a burst of writes stays bounded and keeps the newest data", () => {
    write(40);

    // Active file must be under the limit — that is the whole point.
    const activeSize = existsSync(logPath) ? readFileSync(logPath, "utf8").length : 0;
    expect(activeSize).toBeLessThan(400 + 200); // limit + one line of slack

    // The most recent entry survives somewhere in the chain.
    const all = [
      logPath,
      `${logPath}.1`,
      `${logPath}.2`,
    ]
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("");

    expect(all).toContain("n=39");
  });

  test("never keeps more archives than maxFiles", () => {
    write(60);

    expect(existsSync(`${logPath}.3`)).toBe(false);
    expect(existsSync(`${logPath}.2`)).toBe(true);
  });

  test("every archive line is still valid JSON", () => {
    write(30);

    for (const path of [logPath, `${logPath}.1`, `${logPath}.2`]) {
      if (!existsSync(path)) continue;

      for (const line of readFileSync(path, "utf8").trim().split("\n").filter(Boolean)) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });
});
