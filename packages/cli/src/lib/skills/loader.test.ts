import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadMergedSkills } from "./loader";

function writeSkillMd(dir: string, name: string, description: string, body: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
    "utf-8",
  );
}

describe("loadMergedSkills (D-26)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeFixturePair(
    globalSkills: Array<{ name: string; description: string; body: string }>,
    projectSkills: Array<{ name: string; description: string; body: string }>,
  ) {
    const globalDir = mkdtempSync(join(tmpdir(), "mocode-skills-global-"));
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-skills-project-"));
    tempDirs.push(globalDir, projectDir);

    const globalSkillsRoot = join(globalDir, "skills");
    const projectSkillsRoot = join(projectDir, ".mocode", "skills");
    mkdirSync(globalSkillsRoot, { recursive: true });
    mkdirSync(projectSkillsRoot, { recursive: true });

    for (const skill of globalSkills) {
      writeSkillMd(globalSkillsRoot, skill.name, skill.description, skill.body);
    }
    for (const skill of projectSkills) {
      writeSkillMd(projectSkillsRoot, skill.name, skill.description, skill.body);
    }

    return { globalDir, projectDir, globalSkillsRoot, projectSkillsRoot };
  }

  test("merge: global and project skills union by name", () => {
    const { globalDir, projectDir } = makeFixturePair(
      [{ name: "global-skill", description: "Global", body: "Global body" }],
      [{ name: "project-skill", description: "Project", body: "Project body" }],
    );

    const { skills } = loadMergedSkills(projectDir, { globalSkillsDir: join(globalDir, "skills") });
    const names = skills.map((skill) => skill.name).sort();

    expect(names).toEqual(["global-skill", "project-skill"]);
  });

  test("override: project skill with same name overrides global (D-26)", () => {
    const { globalDir, projectDir } = makeFixturePair(
      [{ name: "write-tests", description: "Global tests", body: "Global write-tests body" }],
      [{ name: "write-tests", description: "Project tests", body: "Project write-tests body" }],
    );

    const { skills } = loadMergedSkills(projectDir, { globalSkillsDir: join(globalDir, "skills") });
    const skill = skills.find((entry) => entry.name === "write-tests");

    expect(skill?.description).toBe("Project tests");
    expect(skill?.body).toContain("Project write-tests body");
    expect(skills.filter((entry) => entry.name === "write-tests")).toHaveLength(1);
  });

  test("invalid frontmatter is skipped while valid skills still load", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-skills-bad-"));
    tempDirs.push(projectDir);
    const skillsRoot = join(projectDir, ".mocode", "skills");
    mkdirSync(join(skillsRoot, "broken"), { recursive: true });
    writeFileSync(join(skillsRoot, "broken", "SKILL.md"), "---\nnot: valid\n---\nBody\n", "utf-8");
    writeSkillMd(skillsRoot, "good-skill", "Good", "Still works");

    const { skills, errors } = loadMergedSkills(projectDir, {
      globalSkillsDir: join(projectDir, "missing-global-skills"),
    });

    expect(skills.map((skill) => skill.name)).toEqual(["good-skill"]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("Invalid skill frontmatter");
  });

  test("honors projectSkillsDir without globalSkillsDir override", () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mocode-skills-project-only-"));
    tempDirs.push(projectDir);
    const customProjectRoot = join(projectDir, "custom-skills");
    mkdirSync(customProjectRoot, { recursive: true });
    writeSkillMd(customProjectRoot, "custom", "Custom", "from custom dir");

    const { skills } = loadMergedSkills(projectDir, {
      projectSkillsDir: customProjectRoot,
      globalSkillsDir: join(projectDir, "no-global"),
    });

    expect(skills.map((skill) => skill.name)).toEqual(["custom"]);
  });
});
