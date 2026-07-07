import { describe, expect, test } from "bun:test";
import { buildSubagentSystemPrompt } from "./prompts";

describe("buildSubagentSystemPrompt", () => {
  test("plan-research prompt lists listDirectory alongside other read-only tools", () => {
    const prompt = buildSubagentSystemPrompt({
      type: "plan-research",
      cwd: "/tmp/project",
      mode: "PLAN",
    });

    expect(prompt).toContain("listDirectory");
    expect(prompt).toContain("readFile");
    expect(prompt).toContain("glob");
  });
});
