export type SkillPromptEntry = {
  name: string;
  description: string;
};

/** Lists discoverable skills for the main agent system prompt (D-29). */
export function buildSkillsSection(skills: SkillPromptEntry[]): string {
  if (skills.length === 0) {
    return "";
  }

  const bullets = skills
    .map((skill) => `- **${skill.name}** — ${skill.description}`)
    .join("\n  ");

  return `
  # Available Skills
  Invoke via slash command (e.g. /skill-name):
  ${bullets}`;
}
