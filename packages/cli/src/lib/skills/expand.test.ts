import { describe, expect, test } from "bun:test";
import { expandSkillMessage, expandSkillSlashMessage } from "./expand";

describe("expandSkillMessage (D-28)", () => {
  test("joins skill body and trailing args with double newline", () => {
    const expanded = expandSkillMessage({ body: "Do X", args: "fix bug" });

    expect(expanded).toContain("Do X");
    expect(expanded).toContain("fix bug");
    expect(expanded).toBe("Do X\n\nfix bug");
  });

  test("returns body only when args empty", () => {
    expect(expandSkillMessage({ body: "Do X", args: "" })).toBe("Do X");
  });
});

describe("expandSkillSlashMessage (D-28)", () => {
  test("expands typed slash command with trailing args", () => {
    const expanded = expandSkillSlashMessage({
      text: "/write-tests fix the bug",
      skills: [{ name: "write-tests", body: "Write comprehensive tests." }],
    });

    expect(expanded).toBe("Write comprehensive tests.\n\nfix the bug");
  });

  test("returns original text when slash name is not a skill", () => {
    expect(
      expandSkillSlashMessage({
        text: "/resume",
        skills: [{ name: "write-tests", body: "Write comprehensive tests." }],
      }),
    ).toBe("/resume");
  });
});
