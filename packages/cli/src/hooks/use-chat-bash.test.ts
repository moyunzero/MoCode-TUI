import { describe, expect, test } from "bun:test";
import { BASH_REJECT_ERROR_TEXT } from "./use-chat";

/** Regression for Phase 01 plan 06 — post-TUI-reject errorText aligns with Rule 11 (D-22/D-23/D-25). */
describe("BASH_REJECT_ERROR_TEXT", () => {
  test("states positive re-ask path via new message and TUI", () => {
    expect(BASH_REJECT_ERROR_TEXT).toMatch(/new message/i);
    expect(BASH_REJECT_ERROR_TEXT).toMatch(/TUI/i);
    expect(BASH_REJECT_ERROR_TEXT).toMatch(/approval dialog/i);
  });

  test("offers manual execution fallback", () => {
    expect(BASH_REJECT_ERROR_TEXT).toMatch(/manually/i);
  });

  test("closes chat confirmation workaround", () => {
    expect(BASH_REJECT_ERROR_TEXT).toMatch(/no chat confirmation path/i);
    expect(BASH_REJECT_ERROR_TEXT).toMatch(/not a permission gate/i);
    expect(BASH_REJECT_ERROR_TEXT).toMatch(/do not retry the same command/i);
  });
});
