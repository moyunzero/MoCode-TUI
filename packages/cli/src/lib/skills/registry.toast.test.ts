import { describe, expect, test } from "bun:test";
import { formatSkillLoadToast } from "./registry";

describe("formatSkillLoadToast", () => {
  test("truncates zod-heavy errors for partial skill loads", () => {
    const error =
      'Invalid skill frontmatter in /tmp/broken/SKILL.md: [{"expected":"string","code":"invalid_type"}]';
    expect(formatSkillLoadToast(error, true)).toBe(
      "Some skills skipped: Invalid skill frontmatter in /tmp/broken/SKILL.md:",
    );
  });

  test("uses disabled wording when no skills loaded", () => {
    expect(formatSkillLoadToast("Invalid skill frontmatter", false)).toBe(
      "Skills disabled: Invalid skill frontmatter",
    );
  });
});
