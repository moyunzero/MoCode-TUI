import { describe, expect, test } from "bun:test";
import { buildSkillCommands } from "./registry";

describe("buildSkillCommands (D-31)", () => {
  test("built-in name collision skips resume and records collision", () => {
    const result = buildSkillCommands([
      {
        name: "resume",
        description: "Conflicts with built-in /resume",
        body: "Should not register",
      },
    ]);

    expect(result.commands).toEqual([]);
    expect(result.collisions).toContain("resume");
  });

  test("non-conflicting skill registers slash command value", () => {
    const result = buildSkillCommands([
      {
        name: "write-tests",
        description: "Generate tests for a module",
        body: "Write comprehensive tests.",
      },
    ]);

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.value).toBe("/write-tests");
    expect(result.commands[0]?.name).toBe("write-tests");
  });
});
