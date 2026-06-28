import { describe, expect, test } from "bun:test";
import { formatChatStreamError } from "./stream-error";

describe("formatChatStreamError", () => {
  test("returns Error.message", () => {
    expect(formatChatStreamError(new Error("Rate limit reached"))).toBe("Rate limit reached");
  });

  test("returns string as-is", () => {
    expect(formatChatStreamError("provider unavailable")).toBe("provider unavailable");
  });

  test("handles null", () => {
    expect(formatChatStreamError(null)).toBe("Unknown error");
  });
});
