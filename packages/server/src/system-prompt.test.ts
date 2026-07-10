import { describe, expect, test } from "bun:test";
import { buildSystemPrompt } from "./system-prompt";

/**
 * Regression suite for Phase 01 bash permission prompt wording (HARNESS-03).
 * Locks Rules 8–11 so future prompt edits cannot reintroduce chat-gated permission
 * or soft retry-offer patterns without failing CI.
 */
describe("buildSystemPrompt", () => {
  describe("BUILD mode bash permission rules", () => {
    const prompt = buildSystemPrompt({ mode: "BUILD" });

    // Plan 04: removed former "explicit user confirmation in chat" rule (D-22).
    test("does not require explicit chat confirmation for destructive bash", () => {
      expect(prompt).not.toMatch(/explicit user confirmation/i);
      expect(prompt).not.toMatch(
        /without explicit user confirmation/i,
      );
    });

    test("states TUI is the sole approval gate for dangerous bash", () => {
      expect(prompt).toMatch(/TUI/i);
      expect(prompt).toMatch(/approval dialog/i);
      expect(prompt).toMatch(/sole/i);
    });

    test("instructs direct bash invocation without chat permission questions", () => {
      expect(prompt).toMatch(/invoke bash directly/i);
      expect(prompt).toMatch(/do not ask the user in chat/i);
    });

    test("encourages optional bash description field", () => {
      expect(prompt).toMatch(/description field/i);
    });

    test("instructs no retry after user rejection unless explicitly asked", () => {
      expect(prompt).toMatch(/output-error/i);
      expect(prompt).toMatch(/do not retry the same command/i);
    });

    // Plan 05: Rule 11 forbids typed chat re-confirmation after TUI reject.
    test("forbids chat re-confirmation after TUI reject on bash", () => {
      const rule11 = prompt.match(/11\. ([^\n]+)/)?.[1];
      expect(rule11).toBeDefined();
      expect(rule11!).toMatch(/output-error/i);
      expect(rule11!).toMatch(/chat/i);
      expect(rule11!).toMatch(/confirm/i);
      expect(rule11!).toMatch(/rejection/i);
      expect(rule11!).toMatch(/TUI/i);
    });

    // Plan 06: Rule 11 extended — no soft "after/if/once you confirm" retry offers.
    test("forbids soft retry-offers contingent on chat confirmation", () => {
      const rule11 = prompt.match(/11\. ([^\n]+)/)?.[1];
      expect(rule11).toBeDefined();
      expect(rule11!).toMatch(/retry/i);
      expect(rule11!).toMatch(/confirm/i);
      expect(rule11!).toMatch(/chat/i);
      expect(rule11!).toMatch(/after you confirm|if you confirm|once you confirm/i);
      expect(rule11!).toMatch(/new message/i);
    });

    // Plan 06: no numbered option menus or chat replies as retry permission gate.
    test("forbids chat reply or option menus as retry permission gate", () => {
      const rule11 = prompt.match(/11\. ([^\n]+)/)?.[1];
      expect(rule11).toBeDefined();
      expect(rule11!).toMatch(/retry/i);
      expect(rule11!).toMatch(/confirm/i);
      expect(rule11!).toMatch(/chat/i);
      expect(rule11!).toMatch(/permission gate|option menu/i);
      expect(rule11!).toMatch(/contingent/i);
    });
  });

  describe("PLAN mode", () => {
    const prompt = buildSystemPrompt({ mode: "PLAN" });

    test("does not list bash in available tools", () => {
      const toolsSection = prompt.match(
        /# Available Tools \(PLAN Mode\)([\s\S]*?)(?=\n {2}\*\*Tool Rules:\*\*|\n {2}# )/,
      )?.[1];
      expect(toolsSection).toBeDefined();
      expect(toolsSection!).not.toMatch(/\bbash\b/);
    });
  });

  describe("skills section", () => {
    test("includes shared skills prompt when skills provided", () => {
      const prompt = buildSystemPrompt({
        mode: "BUILD",
        skills: [{ name: "write-tests", description: "Generate tests" }],
      });

      expect(prompt).toContain("Available Skills");
      expect(prompt).toContain("write-tests");
    });
  });
});
