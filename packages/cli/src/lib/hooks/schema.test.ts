import { describe, expect, test } from "bun:test";
import { hooksConfigSchema } from "./schema";

describe("hooksConfigSchema", () => {
  test("rejects duplicate hook ids in a single file", () => {
    const result = hooksConfigSchema.safeParse({
      hooks: [
        {
          id: "lint-bash",
          event: "beforeToolCall",
          toolName: "bash",
          command: ["echo", "one"],
        },
        {
          id: "lint-bash",
          event: "beforeToolCall",
          toolName: "bash",
          command: ["echo", "two"],
        },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain("Duplicate hook id");
    }
  });
});
