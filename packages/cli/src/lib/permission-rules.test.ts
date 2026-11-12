import { describe, expect, test } from "bun:test";
import {
  buildSandboxEnv,
  evaluateToolPermission,
  findHardDeny,
  isHardDenied,
} from "./permission-rules";

describe("hard denies — not approvable in any mode", () => {
  test("catches filesystem-destroying commands", () => {
    const cases = [
      "rm -rf /",
      "rm -rf /;",
      "rm -rf /&&",
      "rm -rf ~",
      "rm -rf $HOME",
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
      "cat /dev/zero > /dev/sda",
      ":(){ :|:& };:",
    ];

    for (const command of cases) {
      expect(findHardDeny(command)).not.toBeNull();
    }
  });

  test("leaves legitimate work alone", () => {
    const safe = [
      "rm -rf ./dist",
      "rm -rf node_modules",
      "npm test",
      "git status",
      "chmod -R 755 ./scripts",
      "curl -s https://example.com",
    ];

    for (const command of safe) {
      expect(isHardDenied(command)).toBe(false);
    }
  });

  test("reports why the command was refused", () => {
    expect(findHardDeny("mkfs.ext4 /dev/sda1")).toEqual({
      id: "mkfs",
      reason: "formatting a filesystem",
    });
  });
});

describe("evaluateToolPermission", () => {
  test("read-only tools are allowed everywhere, including plan mode", () => {
    for (const mode of ["plan", "default", "acceptEdits", "bypass"] as const) {
      expect(evaluateToolPermission("readFile", mode).action).toBe("allow");
      expect(evaluateToolPermission("grep", mode).action).toBe("allow");
      expect(evaluateToolPermission("gitDiff", mode).action).toBe("allow");
    }
  });

  test("plan mode denies every write path", () => {
    expect(evaluateToolPermission("writeFile", "plan")).toEqual({
      action: "deny",
      reason: "plan mode is read-only",
    });
    expect(evaluateToolPermission("editFile", "plan").action).toBe("deny");
    expect(evaluateToolPermission("bash", "plan").action).toBe("deny");
  });

  test("default mode asks before writing", () => {
    expect(evaluateToolPermission("writeFile", "default")).toEqual({
      action: "ask",
      reason: "write requires approval",
    });
  });

  test("acceptEdits and bypass allow writing", () => {
    expect(evaluateToolPermission("editFile", "acceptEdits").action).toBe("allow");
    expect(evaluateToolPermission("editFile", "bypass").action).toBe("allow");
  });

  test("unknown tools ask rather than guess", () => {
    expect(evaluateToolPermission("mcp__fs__write", "default").action).toBe("ask");
  });
});

describe("buildSandboxEnv", () => {
  const source = {
    PATH: "/usr/bin",
    HOME: "/Users/dev",
    LANG: "zh_CN.UTF-8",
    TERM: "xterm-256color",
    DEEPSEEK_API_KEY: "sk-should-not-leak",
    CLERK_SECRET_KEY: "sk_test_should_not_leak",
    DATABASE_URL: "postgres://user:pass@host/db",
  };

  test("keeps the keys a shell legitimately needs", () => {
    const env = buildSandboxEnv(source);

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/dev");
    expect(env.LANG).toBe("zh_CN.UTF-8");
  });

  test("drops every secret", () => {
    const env = buildSandboxEnv(source);
    const serialized = JSON.stringify(env);

    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
    expect(env.CLERK_SECRET_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(serialized).not.toContain("sk-should-not-leak");
    expect(serialized).not.toContain("postgres://");
  });

  test("forces TERM=dumb so escape codes never reach the TUI", () => {
    expect(buildSandboxEnv(source).TERM).toBe("dumb");
  });

  test("skips unset keys instead of writing undefined", () => {
    const env = buildSandboxEnv({ PATH: "/bin" });
    expect(env.HOME).toBeUndefined();
    expect(Object.values(env).every((value) => typeof value === "string")).toBe(true);
  });
});
