type ExpandSkillMessageParams = {
  body: string;
  args: string;
};

/** Expands skill body plus trailing slash args per D-28. */
export function expandSkillMessage({ body, args }: ExpandSkillMessageParams): string {
  const trimmedArgs = args.trim();
  if (trimmedArgs.length === 0) {
    return body;
  }
  return `${body}\n\n${trimmedArgs}`;
}

const SKILL_SLASH_PATTERN = /^\/([a-z0-9-]+)(?:\s+(.*))?$/i;

type ExpandSkillSlashParams = {
  text: string;
  skills: ReadonlyArray<{ name: string; body: string }>;
};

/** Expands typed `/skill-name args` when name matches a loaded skill. */
export function expandSkillSlashMessage({ text, skills }: ExpandSkillSlashParams): string {
  const match = SKILL_SLASH_PATTERN.exec(text.trim());
  if (!match) {
    return text;
  }

  const [, name, args = ""] = match;
  const skill = skills.find((entry) => entry.name === name);
  if (!skill) {
    return text;
  }

  return expandSkillMessage({ body: skill.body, args });
}
