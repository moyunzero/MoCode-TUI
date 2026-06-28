import { describe, expect, test } from "bun:test";
import { Mode } from "@mocode/shared";
import {
  resolveAutoResumeRequest,
  shouldSkipInterruptedToolOutput,
  trimMessagesForRegenerate,
} from "./stream-interrupt";

describe("shouldSkipInterruptedToolOutput", () => {
  test("returns true when tool call id was marked during Esc interrupt", () => {
    const skipIds = new Set(["tc-esc"]);
    expect(shouldSkipInterruptedToolOutput("tc-esc", skipIds)).toBe(true);
    expect(shouldSkipInterruptedToolOutput("tc-other", skipIds)).toBe(false);
  });
});

describe("trimMessagesForRegenerate", () => {
  test("only patches mode/model on the last retained user message", () => {
    const messages = [
      {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "first" }],
        metadata: { mode: Mode.PLAN, model: "claude-sonnet-4-6" },
      },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "done" }],
        metadata: { mode: Mode.PLAN, model: "claude-sonnet-4-6" },
      },
      {
        id: "u2",
        role: "user",
        parts: [{ type: "text", text: "retry" }],
        metadata: { mode: Mode.PLAN, model: "claude-sonnet-4-6" },
      },
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", text: "partial" }],
        metadata: { mode: Mode.PLAN, model: "claude-sonnet-4-6" },
      },
    ] as never;

    const trimmed = trimMessagesForRegenerate(messages, {
      mode: Mode.BUILD,
      model: "gpt-5.4",
    });

    expect(trimmed).toHaveLength(3);
    expect(trimmed![0].metadata?.mode).toBe(Mode.PLAN);
    expect(trimmed![0].metadata?.model).toBe("claude-sonnet-4-6");
    expect(trimmed![2].metadata?.mode).toBe(Mode.BUILD);
    expect(trimmed![2].metadata?.model).toBe("gpt-5.4");
  });
});

describe("resolveAutoResumeRequest", () => {
  test("auto-resumes user-only tail after stripping empty assistant stub", () => {
    const request = resolveAutoResumeRequest({
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
        { id: "a1", role: "assistant", parts: [] },
      ] as never,
      status: "ready",
      hasAutoResumed: false,
      initialPromptPending: false,
      fallbackMode: Mode.BUILD,
      fallbackModel: "gpt-5.4",
    });

    expect(request).toEqual({
      mode: Mode.BUILD,
      model: "gpt-5.4",
    });
  });

  test("uses last user metadata instead of fallback prompt config", () => {
    const request = resolveAutoResumeRequest({
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
          metadata: { mode: Mode.PLAN, model: "claude-sonnet-4-6" },
        },
      ] as never,
      status: "ready",
      hasAutoResumed: false,
      initialPromptPending: false,
      fallbackMode: Mode.BUILD,
      fallbackModel: "gpt-5.4",
    });

    expect(request).toEqual({
      mode: Mode.PLAN,
      model: "claude-sonnet-4-6",
    });
  });

  test("returns null for partial-assistant tail (manual /resume only)", () => {
    const request = resolveAutoResumeRequest({
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "text", text: "partial" }],
        },
      ] as never,
      status: "ready",
      hasAutoResumed: false,
      initialPromptPending: false,
      fallbackMode: Mode.BUILD,
      fallbackModel: "gpt-5.4",
    });

    expect(request).toBeNull();
  });

  test("falls back when last user metadata has an unsupported model id", () => {
    const request = resolveAutoResumeRequest({
      messages: [
        {
          id: "u1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
          metadata: { mode: Mode.PLAN, model: "retired-model-v99" },
        },
      ] as never,
      status: "ready",
      hasAutoResumed: false,
      initialPromptPending: false,
      fallbackMode: Mode.BUILD,
      fallbackModel: "gpt-5.4",
    });

    expect(request).toEqual({
      mode: Mode.PLAN,
      model: "gpt-5.4",
    });
  });
});
