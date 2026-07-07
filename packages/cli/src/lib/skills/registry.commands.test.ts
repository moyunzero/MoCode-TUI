import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { COMMANDS } from "../../components/command-menu/commands";
import { getAllCommands, initSkillsOnSessionMount, resetSkillsCacheForTests, subscribeSkillsCache } from "./registry";

function writeSkillMd(dir: string, name: string, description: string, body: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf-8",
  );
}

describe("getAllCommands", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    const resetDir = mkdtempSync(join(tmpdir(), "mocode-skills-reset-"));
    tempDirs.push(resetDir);
    initSkillsOnSessionMount(resetDir, {
      globalSkillsDir: join(resetDir, "no-global"),
    });
  });

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("returns built-in commands only before session skills init", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-skills-commands-preinit-"));
    tempDirs.push(projectDir);
    const skillsRoot = join(projectDir, ".mocode", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    writeSkillMd(skillsRoot, "demo-skill", "Demo", "body");

    const commands = getAllCommands(projectDir);
    expect(commands.length).toBe(COMMANDS.length);
    expect(commands.some((command) => command.name === "demo-skill")).toBe(false);
  });

  test("lazy-loads skills on first getAllCommands before explicit init", () => {
    resetSkillsCacheForTests();
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-skills-lazy-"));
    tempDirs.push(projectDir);
    const skillsRoot = join(projectDir, ".mocode", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    writeSkillMd(skillsRoot, "demo-skill", "Demo", "body");

    const commands = getAllCommands(projectDir);
    expect(commands[0]?.name).toBe("demo-skill");
  });

  test("includes skill commands after initSkillsOnSessionMount", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-skills-commands-postinit-"));
    tempDirs.push(projectDir);
    const skillsRoot = join(projectDir, ".mocode", "skills");
    mkdirSync(skillsRoot, { recursive: true });
    writeSkillMd(skillsRoot, "demo-skill", "Demo", "body");

    initSkillsOnSessionMount(projectDir, {
      globalSkillsDir: join(projectDir, "missing-global"),
    });
    const commands = getAllCommands(projectDir);

    expect(commands.some((command) => command.name === "demo-skill")).toBe(true);
    expect(commands[0]?.name).toBe("demo-skill");
  });

  test("subscribeSkillsCache refreshes command consumers after init", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-skills-subscribe-"));
    tempDirs.push(projectDir);
    const skillsRoot = join(projectDir, ".mocode", "skills");
    mkdirSync(skillsRoot, { recursive: true });

    let revision = 0;
    const unsubscribe = subscribeSkillsCache(() => {
      revision += 1;
    });

    initSkillsOnSessionMount(projectDir, {
      globalSkillsDir: join(projectDir, "missing-global"),
    });
    writeSkillMd(skillsRoot, "demo-skill", "Demo", "body");
    initSkillsOnSessionMount(projectDir, {
      globalSkillsDir: join(projectDir, "missing-global"),
    });

    unsubscribe();
    expect(revision).toBeGreaterThanOrEqual(2);
    expect(getAllCommands(projectDir).some((command) => command.name === "demo-skill")).toBe(
      true,
    );
  });
});
