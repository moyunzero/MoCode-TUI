import { describe, expect, test } from "bun:test";
import { DEFAULT_CHAT_MODEL_ID, Mode } from "@mocode/shared";
import { parseInitialMessages, sessionLocationSchema } from "./session-navigation";

describe("sessionLocationSchema", () => {
  test("accepts valid navigation state", () => {
    const result = sessionLocationSchema.safeParse({
      session: { id: "sess-1" },
      initialPrompt: {
        message: "hello",
        mode: Mode.BUILD,
        model: DEFAULT_CHAT_MODEL_ID,
      },
    });

    expect(result.success).toBe(true);
  });

  test("rejects invalid mode and model", () => {
    const result = sessionLocationSchema.safeParse({
      session: { id: "sess-1" },
      initialPrompt: {
        message: "hello",
        mode: "INVALID",
        model: "not-a-model",
      },
    });

    expect(result.success).toBe(false);
  });
});

describe("parseInitialMessages", () => {
  test("returns arrays unchanged", () => {
    const messages = [{ id: "1", role: "user", parts: [] }];
    expect(parseInitialMessages(messages)).toBe(messages);
  });

  test("returns empty array for non-array input", () => {
    expect(parseInitialMessages(null)).toEqual([]);
    expect(parseInitialMessages({})).toEqual([]);
  });
});
