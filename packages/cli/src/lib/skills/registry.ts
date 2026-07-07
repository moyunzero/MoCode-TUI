import type { Command, CommandContext } from "../../components/command-menu/types";
import { COMMANDS } from "../../components/command-menu/commands";
import { expandSkillMessage } from "./expand";
import { loadMergedSkills, type LoadMergedSkillsOptions } from "./loader";
import type { Skill } from "./schema";

export type BuildSkillCommandsResult = {
  commands: Command[];
  collisions: string[];
};

const BUILTIN_COMMAND_NAMES = new Set(COMMANDS.map((command) => command.name));

type BuildSkillCommandsOptions = {
  submit?: (text: string) => void;
};

/** Builds dynamic slash commands from loaded skills; skips built-in name collisions (D-31). */
export function buildSkillCommands(
  skills: Skill[],
  options?: BuildSkillCommandsOptions,
): BuildSkillCommandsResult {
  const commands: Command[] = [];
  const collisions: string[] = [];

  for (const skill of skills) {
    if (BUILTIN_COMMAND_NAMES.has(skill.name)) {
      collisions.push(skill.name);
      continue;
    }

    commands.push({
      name: skill.name,
      description: skill.description,
      value: `/${skill.name}`,
      action: (ctx: CommandContext) => {
        const submit = options?.submit ?? ctx.submit;
        if (!submit) {
          return;
        }

        const expanded = expandSkillMessage({ body: skill.body, args: "" });
        submit(expanded);
      },
    });
  }

  return { commands, collisions };
}

let cachedSkills: Skill[] | null = null;
let cachedCollisions: string[] = [];
const skillsCacheListeners = new Set<() => void>();

function notifySkillsCacheChanged(): void {
  for (const listener of skillsCacheListeners) {
    listener();
  }
}

/** Subscribe to skill cache updates after session init loads skills. */
export function subscribeSkillsCache(listener: () => void): () => void {
  skillsCacheListeners.add(listener);
  return () => {
    skillsCacheListeners.delete(listener);
  };
}

type InitSkillsOptions = LoadMergedSkillsOptions & {
  cwd?: string;
};

/** Shortens zod-heavy skill errors for the toast overlay. */
export function formatSkillLoadToast(error: string, partial: boolean): string {
  const summary = error.split("[")[0]?.trim() || error;
  const clipped = summary.length > 100 ? `${summary.slice(0, 97)}...` : summary;
  return partial ? `Some skills skipped: ${clipped}` : `Skills disabled: ${clipped}`;
}

/** Loads skills once at session bootstrap (D-27). */
export function initSkillsOnSessionMount(
  cwd: string = process.cwd(),
  options?: InitSkillsOptions,
): { skills: Skill[]; collisions: string[]; loadError?: string } {
  const { skills, errors } = loadMergedSkills(cwd, options);
  const { collisions } = buildSkillCommands(skills);
  cachedSkills = skills;
  cachedCollisions = collisions;
  notifySkillsCacheChanged();
  const loadError = errors.length > 0 ? errors.join("; ") : undefined;
  return { skills, collisions, loadError };
}

export function getCachedSkills(): Skill[] {
  return cachedSkills ?? [];
}

export function getCachedSkillCollisions(): string[] {
  return cachedCollisions;
}

type GetAllCommandsOptions = InitSkillsOptions & {
  submit?: (text: string) => void;
};

/** Returns built-in commands plus dynamic skill commands (skills listed first). */
export function getAllCommands(
  cwd: string = process.cwd(),
  options?: GetAllCommandsOptions,
): Command[] {
  if (cachedSkills === null) {
    initSkillsOnSessionMount(cwd, options);
  }

  const skills = cachedSkills ?? [];
  const { commands: skillCommands } = buildSkillCommands(skills, {
    submit: options?.submit,
  });
  const sortedSkills = skillCommands.sort((left, right) => left.name.localeCompare(right.name));

  // Skill slash commands first so they stay visible in the 8-row command menu.
  return [...sortedSkills, ...COMMANDS];
}

export function getCommandColWidth(commands: Command[]): number {
  if (commands.length === 0) {
    return 4;
  }
  return Math.max(...commands.map((command) => command.name.length)) + 4;
}

/** Clears in-memory skill cache — for unit tests only. */
export function resetSkillsCacheForTests(): void {
  cachedSkills = null;
  cachedCollisions = [];
}
