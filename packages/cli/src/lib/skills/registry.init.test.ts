import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSkillsOnSessionMount } from "./registry";

function writeSkillMd(dir: string, name: string, description: string, body: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf-8",
  );
}

describe("initSkillsOnSessionMount", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  test("returns loadError when skills have validation errors", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-skills-registry-bad-"));
    tempDirs.push(projectDir);
    const projectSkillsRoot = join(projectDir, ".mocode", "skills");
    mkdirSync(join(projectSkillsRoot, "broken"), { recursive: true });
    writeFileSync(
      join(projectSkillsRoot, "broken", "SKILL.md"),
      "---\nnot: valid\n---\nBody\n",
      "utf-8",
    );

    const result = initSkillsOnSessionMount(projectDir, {
      globalSkillsDir: join(projectDir, "missing-global-skills"),
    });
    expect(result.skills).toEqual([]);
    expect(result.collisions).toEqual([]);
    expect(result.loadError).toContain("Invalid skill frontmatter");
  });

  test("returns loadError but keeps valid skills when one skill is broken", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-skills-registry-mixed-"));
    tempDirs.push(projectDir);
    const projectSkillsRoot = join(projectDir, ".mocode", "skills");
    mkdirSync(join(projectSkillsRoot, "broken"), { recursive: true });
    writeFileSync(
      join(projectSkillsRoot, "broken", "SKILL.md"),
      "---\nnot: valid\n---\nBody\n",
      "utf-8",
    );
    writeSkillMd(projectSkillsRoot, "ok-skill", "OK", "works");

    const result = initSkillsOnSessionMount(projectDir, {
      globalSkillsDir: join(projectDir, "missing-global-skills"),
    });
    expect(result.skills.map((skill) => skill.name)).toEqual(["ok-skill"]);
    expect(result.loadError).toContain("Invalid skill frontmatter");
  });

  test("loads skills normally when loader succeeds", () => {
    const globalDir = mkdtempSync(join(tmpdir(), "mocode-skills-registry-global-"));
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-skills-registry-project-"));
    tempDirs.push(globalDir, projectDir);

    const globalSkillsRoot = join(globalDir, "skills");
    const projectSkillsRoot = join(projectDir, ".mocode", "skills");
    mkdirSync(globalSkillsRoot, { recursive: true });
    mkdirSync(projectSkillsRoot, { recursive: true });
    writeSkillMd(globalSkillsRoot, "ship", "Ship it", "do ship");

    const result = initSkillsOnSessionMount(projectDir, {
      globalSkillsDir: globalSkillsRoot,
      projectSkillsDir: projectSkillsRoot,
    });
    expect(result.loadError).toBeUndefined();
    expect(result.skills).toHaveLength(1);
  });
});
