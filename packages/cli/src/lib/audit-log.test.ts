import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultAuditPath, recordAudit, summarizeInput } from "./audit-log";

const dir = mkdtempSync(join(tmpdir(), "mocode-audit-"));
const logPath = join(dir, "audit.jsonl");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function lines(): Array<Record<string, unknown>> {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("summarizeInput", () => {
  test("keeps short scalars that identify the call", () => {
    expect(summarizeInput({ path: "src/a.ts", line_start: 3 })).toBe("path=src/a.ts line_start=3");
  });

  test("never records file contents", () => {
    const body = "x".repeat(5_000);
    expect(summarizeInput({ path: "a.ts", content: body })).toBe("path=a.ts");
  });

  test("records the command — an audit entry without it cannot be reviewed", () => {
    expect(summarizeInput({ command: "cat ~/.ssh/id_rsa", description: "list" })).toBe(
      "command=cat ~/.ssh/id_rsa description=list",
    );
  });

  test("masks credentials that appear inside a command", () => {
    expect(summarizeInput({ command: "export ANTHROPIC_API_KEY=abcd1234efgh" })).not.toContain(
      "abcd1234efgh",
    );
    expect(summarizeInput({ command: 'curl -H "Authorization: Bearer sk-live-abcdef123456"' })).not.toContain(
      "sk-live-abcdef123456",
    );
    expect(summarizeInput({ command: "sk-abcdefghijklmnop tool" })).not.toContain("abcdefghijklmnop");
  });

  test("masks X-API-Key and other credential headers", () => {
    expect(
      summarizeInput({ command: 'curl -H "X-API-Key: sk-live-abcdef123456" https://x' }),
    ).not.toContain("sk-live-abcdef123456");

    expect(summarizeInput({ command: "curl -H 'X-Api-Key: plainsecretvalue' https://x" }))
      .not.toContain("plainsecretvalue");
  });

  test("never records edit payloads", () => {
    expect(
      summarizeInput({ path: "a.ts", oldString: "secret", newString: "other" }),
    ).toBe("path=a.ts");
  });

  test("drops multi-line values even when short", () => {
    expect(summarizeInput({ path: "a.ts", description: "a\nb" })).toBe("path=a.ts");
  });

  test("is bounded regardless of how many keys arrive", () => {
    const input = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`path${i}`, "v".repeat(50)]),
    );
    // Unknown keys are ignored; only the allowlisted `path` field is kept.
    expect(summarizeInput({ ...input, path: "src/a.ts" }).length).toBeLessThanOrEqual(240);
    expect(summarizeInput({ ...input, path: "src/a.ts" })).toContain("path=src/a.ts");
  });

  test("non-object input yields nothing", () => {
    expect(summarizeInput(null)).toBe("");
    expect(summarizeInput("raw")).toBe("");
  });
});

describe("recordAudit", () => {
  test("appends one JSON line per decision", () => {
    recordAudit({ tool: "readFile", mode: "BUILD", outcome: "ok", detail: "path=a.ts" }, logPath);
    recordAudit(
      { tool: "readFile", mode: "BUILD", outcome: "denied", code: "PATH_ESCAPE", detail: "path=/etc" },
      logPath,
    );

    const entries = lines();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ tool: "readFile", outcome: "ok" });
    expect(entries[1]).toMatchObject({ outcome: "denied", code: "PATH_ESCAPE" });
  });

  test("stamps every entry with an ISO timestamp", () => {
    recordAudit({ tool: "bash", mode: "BUILD", outcome: "denied", code: "HARD_DENY" }, logPath);

    const entry = lines().at(-1);
    expect(typeof entry?.timestamp).toBe("string");
    expect(Number.isNaN(Date.parse(String(entry?.timestamp)))).toBe(false);
  });

  test("creates the directory when it does not exist", () => {
    const nested = join(dir, "deep", "nested", "audit.jsonl");
    expect(recordAudit({ tool: "grep", mode: "BUILD", outcome: "ok" }, nested)).toBe(true);
  });

  test("fails soft instead of throwing when the path is unusable", () => {
    // A directory cannot be appended to as a file.
    expect(recordAudit({ tool: "bash", mode: "BUILD", outcome: "ok" }, dir)).toBe(false);
  });

  test("honours MOCODE_AUDIT_PATH", () => {
    process.env.MOCODE_AUDIT_PATH = logPath;
    try {
      expect(defaultAuditPath()).toBe(logPath);
    } finally {
      delete process.env.MOCODE_AUDIT_PATH;
    }
  });
});

describe("shell commands are auditable", () => {
  test("the command itself is recorded — an entry without it is useless", () => {
    expect(summarizeInput({ command: "head -1 /etc/passwd" })).toBe("command=head -1 /etc/passwd");
  });

  test("multi-line commands are collapsed, not dropped", () => {
    const summary = summarizeInput({ command: "ls -la\nfile secret.txt" });
    expect(summary).toBe("command=ls -la file secret.txt");
  });

  test("a command containing a heredoc is capped, not logged in full", () => {
    const body = "cat <<'X'\n" + "y".repeat(2_000) + "\nX";
    const summary = summarizeInput({ command: body });
    expect(summary.length).toBeLessThanOrEqual(240);
    expect(summary.startsWith("command=")).toBe(true);
  });

  test("file bodies are still dropped", () => {
    expect(summarizeInput({ path: "a.ts", content: "x".repeat(500) })).toBe("path=a.ts");
  });

  test("command and description both survive", () => {
    const summary = summarizeInput({
      command: "ls -la secret.txt",
      description: "Inspect link",
    });
    expect(summary).toContain("command=ls -la secret.txt");
    expect(summary).toContain("description=Inspect link");
  });
});
