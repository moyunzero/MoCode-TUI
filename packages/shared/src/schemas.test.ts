import { describe, expect, test } from "bun:test";
import { Mode, modeSchema, getToolContracts } from "./schemas";
import {
  DEFAULT_CHAT_MODEL_ID,
  findSupportedChatModel,
  supportedChatModelIdSchema,
} from "./models";

describe("modeSchema", () => {
  test("accepts BUILD and PLAN", () => {
    expect(modeSchema.safeParse(Mode.BUILD).success).toBe(true);
    expect(modeSchema.safeParse(Mode.PLAN).success).toBe(true);
  });

  test("rejects unknown modes", () => {
    expect(modeSchema.safeParse("INVALID").success).toBe(false);
  });
});

describe("supportedChatModelIdSchema", () => {
  test("accepts catalog ids", () => {
    expect(supportedChatModelIdSchema.safeParse(DEFAULT_CHAT_MODEL_ID).success).toBe(true);
    expect(findSupportedChatModel(DEFAULT_CHAT_MODEL_ID)).not.toBeNull();
  });

  test("rejects unknown ids", () => {
    expect(supportedChatModelIdSchema.safeParse("fake/model").success).toBe(false);
  });
});

describe("getToolContracts", () => {
  test("PLAN exposes read-only tools only", () => {
    const tools = getToolContracts(Mode.PLAN);
    expect(Object.keys(tools).sort()).toEqual(
      ["glob", "grep", "gitDiff", "gitStatus", "listDirectory", "readFile"].sort(),
    );
  });

  test("BUILD exposes read-only tools plus write/bash", () => {
    const tools = getToolContracts(Mode.BUILD);
    expect(Object.keys(tools).sort()).toEqual(
      [
        "bash",
        "editFile",
        "glob",
        "grep",
        "gitDiff",
        "gitStatus",
        "listDirectory",
        "readFile",
        "writeFile",
      ].sort(),
    );
  });
});
