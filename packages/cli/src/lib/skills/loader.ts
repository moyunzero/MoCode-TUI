import { existsSync, readdirSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { type Skill, skillFrontmatterSchema } from "./schema";

const CONFIG_DIR = ".mocode";
const SKILLS_DIR = "skills";
const SKILL_FILE = "SKILL.md";

export type SkillsPaths = {
  global: string;
  project: string;
};

export type LoadMergedSkillsOptions = {
  globalSkillsDir?: string;
  projectSkillsDir?: string;
};

export type LoadMergedSkillsResult = {
  skills: Skill[];
  errors: string[];
};

/** Returns filesystem paths for global and project skill directories. */
export function getSkillsPaths(cwd: string): SkillsPaths {
  return {
    global: join(homedir(), CONFIG_DIR, SKILLS_DIR),
    project: join(cwd, CONFIG_DIR, SKILLS_DIR),
  };
}

function resolveSkillsPaths(cwd: string, options?: LoadMergedSkillsOptions): SkillsPaths {
  const defaults = getSkillsPaths(cwd);
  return {
    global: options?.globalSkillsDir ?? defaults.global,
    project: options?.projectSkillsDir ?? defaults.project,
  };
}

function listSkillDirectories(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name));
}

function loadSkillFromDirectory(skillDir: string): Skill {
  const skillPath = join(skillDir, SKILL_FILE);
  if (!existsSync(skillPath)) {
    throw new Error(`Missing ${SKILL_FILE} in ${skillDir}`);
  }

  const directoryName = basename(skillDir);
  const raw = readFileSync(skillPath, "utf-8");
  const parsed = matter(raw);
  const frontmatter = skillFrontmatterSchema.safeParse(parsed.data);

  if (!frontmatter.success) {
    throw new Error(
      `Invalid skill frontmatter in ${skillPath}: ${frontmatter.error.message}`,
    );
  }

  if (frontmatter.data.name !== directoryName) {
    throw new Error(
      `Skill name "${frontmatter.data.name}" must match directory "${directoryName}" in ${skillPath}`,
    );
  }

  return {
    name: frontmatter.data.name,
    description: frontmatter.data.description,
    body: parsed.content.trim(),
  };
}

function loadSkillsFromRoot(root: string): { skills: Skill[]; errors: string[] } {
  const skills: Skill[] = [];
  const errors: string[] = [];

  for (const skillDir of listSkillDirectories(root)) {
    try {
      skills.push(loadSkillFromDirectory(skillDir));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(message);
      console.warn(`Skipping invalid skill at ${skillDir}: ${message}`);
    }
  }

  return { skills, errors };
}

/**
 * Loads and merges skills from global ~/.mocode/skills/ and project .mocode/skills/.
 * Project entries override global entries with the same name (D-26).
 * Invalid skill directories are skipped; their errors are returned alongside valid skills.
 */
export function loadMergedSkills(
  cwd: string,
  options?: LoadMergedSkillsOptions,
): LoadMergedSkillsResult {
  const paths = resolveSkillsPaths(cwd, options);

  const globalResult = loadSkillsFromRoot(paths.global);
  const projectResult = loadSkillsFromRoot(paths.project);
  const loadErrors = [...globalResult.errors, ...projectResult.errors];

  const merged = new Map<string, Skill>();

  for (const skill of globalResult.skills) {
    merged.set(skill.name, skill);
  }
  for (const skill of projectResult.skills) {
    merged.set(skill.name, skill);
  }

  return {
    skills: [...merged.values()].sort((left, right) => left.name.localeCompare(right.name)),
    errors: loadErrors,
  };
}
