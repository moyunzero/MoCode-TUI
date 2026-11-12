import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateRules,
  loadPermissionRules,
  loadRuleFile,
  parseRules,
  ruleSubject,
  type LoadedRule,
} from "./permissions";

const dir = mkdtempSync(join(tmpdir(), "mocode-perms-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeRules(path: string, content: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("parseRules", () => {
  test("accepts the documented shape", () => {
    const result = parseRules(
      { rules: [{ tool: "bash", pattern: "^npm ", behavior: "allow" }] },
      "project",
    );

    expect(result.errors).toEqual([]);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({ tool: "bash", behavior: "allow", source: "project" });
  });

  test("drops a rule with a bad behaviour instead of coercing it", () => {
    // Coercing `"denied"` into an allow would be the worst possible failure.
    const result = parseRules({ rules: [{ tool: "bash", behavior: "denied" }] }, "user");

    expect(result.rules).toEqual([]);
    expect(result.errors[0]).toContain("behavior");
  });

  test("drops a rule with an invalid regex and says so", () => {
    const result = parseRules({ rules: [{ tool: "bash", pattern: "([", behavior: "deny" }] }, "user");

    expect(result.rules).toEqual([]);
    expect(result.errors[0]).toContain("invalid regex");
  });

  test("requires a tool name", () => {
    const result = parseRules({ rules: [{ behavior: "deny" }] }, "user");
    expect(result.errors[0]).toContain("tool");
  });

  test("reports a non-array rules field", () => {
    expect(parseRules({ rules: "nope" }, "user").errors[0]).toContain("array");
  });

  test("an empty object is not an error", () => {
    expect(parseRules({}, "user").errors).toEqual([]);
  });
});

describe("loadRuleFile", () => {
  test("a missing file is normal, not an error", () => {
    expect(loadRuleFile(join(dir, "nope.json"), "user")).toEqual({ rules: [], errors: [] });
  });

  test("invalid JSON is reported and yields no rules", () => {
    const path = writeRules(join(dir, "bad.json"), "{ not json");
    const result = loadRuleFile(path, "project");

    expect(result.rules).toEqual([]);
    expect(result.errors[0]).toContain("invalid JSON");
  });
});

describe("loadPermissionRules", () => {
  test("merges user and project files, tagging the source", () => {
    const userPath = writeRules(
      join(dir, "user.json"),
      JSON.stringify({ rules: [{ tool: "bash", behavior: "ask" }] }),
    );
    const projectPath = writeRules(
      join(dir, "project.json"),
      JSON.stringify({ rules: [{ tool: "writeFile", behavior: "deny" }] }),
    );

    const result = loadPermissionRules(dir, { user: userPath, project: projectPath });

    expect(result.rules.map((rule) => rule.source)).toEqual(["user", "project"]);
  });
});

describe("evaluateRules", () => {
  function rules(...entries: Array<Partial<LoadedRule>>): LoadedRule[] {
    return entries.map((entry) => ({
      tool: "bash",
      behavior: "ask",
      source: "project",
      pattern: undefined,
      regex: null,
      ...entry,
    })) as LoadedRule[];
  }

  test("a deny anywhere wins over an allow everywhere", () => {
    const list = rules(
      { tool: "bash", behavior: "allow", source: "user" },
      { tool: "bash", behavior: "deny", source: "project" },
    );

    expect(evaluateRules(list, "bash", "rm -rf /")).toMatchObject({ behavior: "deny" });
  });

  test("an allow suppresses the ask", () => {
    const list = rules({ tool: "bash", behavior: "allow", regex: /^npm / });

    expect(evaluateRules(list, "bash", "npm test")).toMatchObject({ behavior: "allow" });
    expect(evaluateRules(list, "bash", "curl x")).toBeNull();
  });

  test("wildcard tools match everything", () => {
    const list = rules({ tool: "*", behavior: "deny" });
    expect(evaluateRules(list, "writeFile", "a.txt")).toMatchObject({ behavior: "deny" });
  });

  test("first match wins within one behaviour", () => {
    const list = rules(
      { tool: "bash", behavior: "deny", regex: /^git push/ },
      { tool: "bash", behavior: "deny", regex: /^git/ },
    );

    expect(evaluateRules(list, "bash", "git push origin main")?.rule.regex?.source).toBe(
      "^git push",
    );
  });

  test("no match returns null so the caller keeps its own policy", () => {
    expect(evaluateRules(rules({ tool: "writeFile", behavior: "deny" }), "bash", "ls")).toBeNull();
  });
});

describe("ruleSubject", () => {
  test("bash matches on the command", () => {
    expect(ruleSubject("bash", { command: "npm test" })).toBe("npm test");
  });

  test("file tools match on the path", () => {
    expect(ruleSubject("writeFile", { path: "src/a.ts", content: "x" })).toBe("src/a.ts");
  });

  test("unknown input yields an empty subject", () => {
    expect(ruleSubject("bash", null)).toBe("");
  });
});
