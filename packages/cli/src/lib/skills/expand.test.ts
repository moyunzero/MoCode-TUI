import { describe, expect, test } from "bun:test";
import { expandSkillMessage } from "./expand";

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
