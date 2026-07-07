import { describe, expect, test } from "bun:test";
import { formatHookBlockToast } from "./toast-message";

describe("formatHookBlockToast (UI-SPEC §4)", () => {
  test("policy block uses Hook blocked template", () => {
    expect(
      formatHookBlockToast("bash", { reason: "UAT policy block" }),
    ).toBe("Hook blocked bash: UAT policy block");
  });

  test("timeout uses hook id template", () => {
    expect(
      formatHookBlockToast("bash", {
        reason: "Hook timed out",
        hookId: "uat-block-bash",
        hookTimedOut: true,
      }),
    ).toBe("Hook timed out — uat-block-bash blocked bash");
  });

  test("timeout without hook id falls back to generic block", () => {
    expect(
      formatHookBlockToast("bash", { reason: "Hook timed out", hookTimedOut: true }),
    ).toBe("Hook blocked bash: Hook timed out");
  });
});
