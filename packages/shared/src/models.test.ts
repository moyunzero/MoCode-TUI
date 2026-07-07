import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CHAT_MODEL_ID,
  formatModelCatalogHint,
  getModelCatalogHint,
  sortModelsForCatalogPicker,
  type SupportedChatModelId,
} from "./models";

describe("model catalog hints", () => {
  test("default model is Cerebras gpt-oss-120b", () => {
    expect(DEFAULT_CHAT_MODEL_ID).toBe("gpt-oss-120b");
  });

  test("marks free-tier tool-calling guidance", () => {
    expect(getModelCatalogHint("gpt-oss-120b")).toBe("free-recommended");
    expect(getModelCatalogHint("openai/gpt-oss-20b")).toBe("free-ok");
    expect(formatModelCatalogHint("weak-tools")).toBe("工具调用不稳定");
  });

  test("sortModelsForCatalogPicker puts recommended first and weak tools last", () => {
    const ids: SupportedChatModelId[] = [
      "llama-3.3-70b-versatile",
      "gpt-oss-120b",
      "claude-sonnet-4-6",
      "gemini-2.5-flash",
    ];
    expect(sortModelsForCatalogPicker(ids)).toEqual([
      "gpt-oss-120b",
      "gemini-2.5-flash",
      "claude-sonnet-4-6",
      "llama-3.3-70b-versatile",
    ]);
  });
});
