import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMergedHooksConfig } from "./loader";

function writeHooksJson(dir: string, data: unknown): string {
  const mocodeDir = join(dir, ".mocode");
  mkdirSync(mocodeDir, { recursive: true });
  const path = join(mocodeDir, "hooks.json");
  writeFileSync(path, JSON.stringify(data), "utf-8");
  return path;
}

describe("loadMergedHooksConfig (D-33)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeFixturePair(globalData: unknown, projectData: unknown) {
    const globalDir = mkdtempSync(join(tmpdir(), "mocode-hooks-global-"));
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-hooks-project-"));
    tempDirs.push(globalDir, projectDir);

    const globalPath = writeHooksJson(globalDir, globalData);
    const projectPath = writeHooksJson(projectDir, projectData);

    return { globalPath, projectPath, projectDir };
  }

  test("merge: global hooks merged with project hooks", () => {
    const { globalPath, projectPath, projectDir } = makeFixturePair(
      {
        hooks: [
          {
            id: "global-hook",
            event: "beforeToolCall",
            toolName: "bash",
            command: ["echo", "global"],
          },
        ],
      },
      {
        hooks: [
          {
            id: "project-hook",
            event: "beforeToolCall",
            toolName: "writeFile",
            command: ["echo", "project"],
          },
        ],
      },
    );

    const config = loadMergedHooksConfig(projectDir, { globalPath, projectPath });
    const ids = config.hooks.map((hook) => hook.id).sort();

    expect(ids).toEqual(["global-hook", "project-hook"]);
  });

  test("override: project hook with same id overrides global (D-33)", () => {
    const { globalPath, projectPath, projectDir } = makeFixturePair(
      {
        hooks: [
          {
            id: "lint-bash",
            event: "beforeToolCall",
            toolName: "bash",
            command: ["echo", "global"],
          },
        ],
      },
      {
        hooks: [
          {
            id: "lint-bash",
            event: "beforeToolCall",
            toolName: "bash",
            command: ["echo", "project"],
          },
        ],
      },
    );

    const config = loadMergedHooksConfig(projectDir, { globalPath, projectPath });
    const hook = config.hooks.find((entry) => entry.id === "lint-bash");

    expect(hook?.command).toEqual(["echo", "project"]);
    expect(config.hooks.filter((entry) => entry.id === "lint-bash")).toHaveLength(1);
  });

  test("invalid JSON throws parse error with hooks prefix", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-hooks-bad-"));
    tempDirs.push(projectDir);
    const mocodeDir = join(projectDir, ".mocode");
    mkdirSync(mocodeDir, { recursive: true });
    const projectPath = join(mocodeDir, "hooks.json");
    writeFileSync(projectPath, "{ not valid json", "utf-8");

    expect(() =>
      loadMergedHooksConfig(projectDir, {
        globalPath: join(projectDir, "missing-global.json"),
        projectPath,
      }),
    ).toThrow(/hooks/i);
  });
});
