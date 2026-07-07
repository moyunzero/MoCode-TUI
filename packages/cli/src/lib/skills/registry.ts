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

type InitSkillsOptions = LoadMergedSkillsOptions & {
  cwd?: string;
};

/** Loads skills once at session bootstrap (D-27). */
export function initSkillsOnSessionMount(
  cwd: string = process.cwd(),
  options?: InitSkillsOptions,
): { skills: Skill[]; collisions: string[]; loadError?: string } {
  try {
    const skills = loadMergedSkills(cwd, options);
    const { collisions } = buildSkillCommands(skills);
    cachedSkills = skills;
    cachedCollisions = collisions;
    return { skills, collisions };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cachedSkills = [];
    cachedCollisions = [];
    return { skills: [], collisions: [], loadError: message };
  }
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

/** Returns built-in commands plus dynamic skill commands sorted after static entries. */
export function getAllCommands(
  cwd: string = process.cwd(),
  options?: GetAllCommandsOptions,
): Command[] {
  const skills = cachedSkills ?? loadMergedSkills(cwd, options);
  const { commands: skillCommands } = buildSkillCommands(skills, {
    submit: options?.submit,
  });

  return [...COMMANDS, ...skillCommands.sort((left, right) => left.name.localeCompare(right.name))];
}

export function getCommandColWidth(commands: Command[]): number {
  if (commands.length === 0) {
    return 4;
  }
  return Math.max(...commands.map((command) => command.name.length)) + 4;
}
