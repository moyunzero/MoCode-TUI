import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mcpConfigSchema } from "./config-schema";
import { getEnabledServers, loadMergedMcpConfig } from "./config";

function writeMcpJson(dir: string, data: unknown): string {
  const mocodeDir = join(dir, ".mocode");
  mkdirSync(mocodeDir, { recursive: true });
  const path = join(mocodeDir, "mcp.json");
  writeFileSync(path, JSON.stringify(data), "utf-8");
  return path;
}

describe("mcpConfigSchema", () => {
  test("schema: stdio without command fails parse", () => {
    const result = mcpConfigSchema.safeParse({
      mcpServers: {
        bad: { transport: "stdio" },
      },
    });

    expect(result.success).toBe(false);
  });

  test("schema: enabled:false stdio entry parses", () => {
    const result = mcpConfigSchema.safeParse({
      mcpServers: {
        fs: { transport: "stdio", command: "npx", enabled: false },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers.fs.enabled).toBe(false);
    }
  });

  test("schema: timeoutMs defaults to 60000 when omitted", () => {
    const result = mcpConfigSchema.safeParse({
      mcpServers: {
        fs: { transport: "stdio", command: "npx" },
      },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpServers.fs.timeoutMs).toBe(60000);
    }
  });

  test("schema: http without url fails parse", () => {
    const result = mcpConfigSchema.safeParse({
      mcpServers: {
        remote: { transport: "http" },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("loadMergedMcpConfig", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeFixturePair(globalData: unknown, projectData: unknown) {
    const globalDir = mkdtempSync(join(tmpdir(), "mocode-mcp-global-"));
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-mcp-project-"));
    tempDirs.push(globalDir, projectDir);

    const globalPath = writeMcpJson(globalDir, globalData);
    const projectPath = writeMcpJson(projectDir, projectData);

    return { globalPath, projectPath, projectDir };
  }

  test("merge: global mcpServers merged with project", () => {
    const { globalPath, projectPath, projectDir } = makeFixturePair(
      {
        mcpServers: {
          globalServer: { transport: "stdio", command: "echo", args: ["global"] },
        },
      },
      {
        mcpServers: {
          projectServer: { transport: "stdio", command: "echo", args: ["project"] },
        },
      },
    );

    const config = loadMergedMcpConfig(projectDir, {
      globalPath,
      projectPath,
    });

    expect(config.mcpServers.globalServer).toBeDefined();
    expect(config.mcpServers.projectServer).toBeDefined();
  });

  test("override: same server name in project overrides global", () => {
    const { globalPath, projectPath, projectDir } = makeFixturePair(
      {
        mcpServers: {
          shared: { transport: "stdio", command: "echo", args: ["global"] },
        },
      },
      {
        mcpServers: {
          shared: { transport: "stdio", command: "echo", args: ["project"] },
        },
      },
    );

    const config = loadMergedMcpConfig(projectDir, {
      globalPath,
      projectPath,
    });

    expect(config.mcpServers.shared.args).toEqual(["project"]);
  });

  test("override: project http replaces global stdio for same name", () => {
    const { globalPath, projectPath, projectDir } = makeFixturePair(
      {
        mcpServers: {
          alpha: { transport: "stdio", command: "a" },
        },
      },
      {
        mcpServers: {
          beta: { transport: "stdio", command: "b" },
          alpha: { transport: "http", url: "http://x" },
        },
      },
    );

    const config = loadMergedMcpConfig(projectDir, {
      globalPath,
      projectPath,
    });

    expect(Object.keys(config.mcpServers).sort()).toEqual(["alpha", "beta"]);
    expect(config.mcpServers.alpha.transport).toBe("http");
    expect(config.mcpServers.alpha.url).toBe("http://x");
    expect(config.mcpServers.beta.command).toBe("b");
  });

  test("missing files returns empty config", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "mocode-mcp-empty-"));
    tempDirs.push(emptyDir);

    const config = loadMergedMcpConfig(emptyDir, {
      globalPath: join(emptyDir, "missing-global.json"),
      projectPath: join(emptyDir, "missing-project.json"),
    });

    expect(config.mcpServers).toEqual({});
  });
});

describe("getEnabledServers", () => {
  test("enabled: disabled server (enabled:false) excluded", () => {
    const config = mcpConfigSchema.parse({
      mcpServers: {
        active: { transport: "stdio", command: "echo", args: [], enabled: true },
        disabled: { transport: "stdio", command: "echo", args: [], enabled: false },
      },
    });

    const enabled = getEnabledServers(config);

    expect(enabled.active).toBeDefined();
    expect(enabled.disabled).toBeUndefined();
    expect(Object.keys(enabled)).toEqual(["active"]);
  });
});
