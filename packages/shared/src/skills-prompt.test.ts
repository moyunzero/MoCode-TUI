import { describe, expect, test } from "bun:test";
import { buildSkillsSection } from "./skills-prompt";

describe("buildSkillsSection (D-29)", () => {
  test("returns empty string when no skills", () => {
    expect(buildSkillsSection([])).toBe("");
  });

  test("lists skill name and description", () => {
    const section = buildSkillsSection([
      { name: "write-tests", description: "Generate tests for a module" },
    ]);

    expect(section).toContain("Available Skills");
    expect(section).toContain("write-tests");
    expect(section).toContain("Generate tests for a module");
    expect(section).toContain("/skill-name");
  });
});
