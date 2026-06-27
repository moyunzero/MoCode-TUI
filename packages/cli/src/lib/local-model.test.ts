import { describe, expect, test } from "bun:test";
import { resolveChatModel } from "./local-model";
import type { ProviderKeys } from "./keys";

describe("resolveChatModel", () => {
  test("throws with /keys guidance when getKeys returns null", () => {
    expect(() =>
      resolveChatModel("claude-sonnet-4-6", { getKeys: () => null }),
    ).toThrow(/\/keys/i);
  });

  test("throws when provider apiKey is missing", () => {
    const keys: ProviderKeys = { openai: { apiKey: "sk-test" } };
    expect(() =>
      resolveChatModel("claude-sonnet-4-6", { getKeys: () => keys }),
    ).toThrow(/\/keys/i);
  });

  test("returns LanguageModel when anthropic apiKey is present", () => {
    const keys: ProviderKeys = { anthropic: { apiKey: "sk-ant-test" } };
    const resolved = resolveChatModel("claude-sonnet-4-6", { getKeys: () => keys });
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.modelId).toBe("claude-sonnet-4-6");
    expect(resolved.model).toBeDefined();
  });

  test("returns LanguageModel when openai apiKey is present", () => {
    const keys: ProviderKeys = { openai: { apiKey: "sk-test" } };
    const resolved = resolveChatModel("gpt-5.4", { getKeys: () => keys });
    expect(resolved.provider).toBe("openai");
    expect(resolved.modelId).toBe("gpt-5.4");
    expect(resolved.model).toBeDefined();
  });
});
