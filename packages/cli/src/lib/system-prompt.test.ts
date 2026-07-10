import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./system-prompt";

describe("buildSystemPrompt skills integration", () => {
  test("includes skills section when skills provided", () => {
    const prompt = buildSystemPrompt({
      mode: "BUILD",
      skills: [{ name: "write-tests", description: "Generate tests" }],
    });

    expect(prompt).toContain("Available Skills");
    expect(prompt).toContain("write-tests");
  });
});
