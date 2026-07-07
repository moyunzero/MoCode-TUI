import { describe, expect, test } from "bun:test";
import {
  Mode,
  modeSchema,
  getToolContracts,
  readOnlyToolContracts,
  buildToolContracts,
  toolInputSchemas,
} from "./schemas";
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
      ["glob", "grep", "gitDiff", "gitStatus", "listDirectory", "readFile", "task"].sort(),
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
        "task",
        "writeFile",
      ].sort(),
    );
  });
});

describe("task tool contract (D-01, HARNESS-09)", () => {
  test("PLAN mode includes task tool", () => {
    const tools = getToolContracts(Mode.PLAN);
    expect(tools).toHaveProperty("task");
  });

  test("BUILD mode includes task tool", () => {
    const tools = getToolContracts(Mode.BUILD);
    expect(tools).toHaveProperty("task");
  });

  test("task appears in readOnlyToolContracts and buildToolContracts", () => {
    expect(readOnlyToolContracts).toHaveProperty("task");
    expect(buildToolContracts).toHaveProperty("task");
  });

  test("task inputSchema accepts explore and plan-research subagent_type", () => {
    const schema = toolInputSchemas.task;
    expect(schema.safeParse({
      subagent_type: "explore",
      prompt: "Find auth handlers",
    }).success).toBe(true);
    expect(schema.safeParse({
      subagent_type: "plan-research",
      prompt: "Compare JWT vs session auth",
      description: "Architecture research",
    }).success).toBe(true);
  });

  test("task inputSchema rejects unknown subagent_type", () => {
    const schema = toolInputSchemas.task;
    expect(schema.safeParse({
      subagent_type: "custom-agent",
      prompt: "Do work",
    }).success).toBe(false);
  });
});

describe("readFile tool schema", () => {
  test("accepts path-only and optional line range", () => {
    const schema = toolInputSchemas.readFile;
    expect(schema.safeParse({ path: "src/index.ts" }).success).toBe(true);
    expect(
      schema.safeParse({ path: "src/index.ts", line_start: 1, line_end: 40 }).success,
    ).toBe(true);
  });
});
