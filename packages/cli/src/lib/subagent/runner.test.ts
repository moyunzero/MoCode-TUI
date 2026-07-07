import { beforeEach, describe, expect, mock, test } from "bun:test";
import { runSubagent } from "./runner";

const generateTextMock = mock(async () => ({
  text: "Subagent completed: found 3 auth handlers.",
  steps: [{ stepType: "initial" }],
}));

const isLocalModeMock = mock(() => true);
const resolveChatModelMock = mock(() => ({
  model: {} as unknown,
  providerOptions: undefined,
}));
const executeLocalToolMock = mock(async () => ({ ok: true }));
const postSubagentChatStreamMock = mock(async () => new Response("ok"));
const consumeSubagentStreamMock = mock(async () => ({
  id: "assistant-1",
  role: "assistant",
  parts: [{ type: "text", text: "packages/cli contains src and package.json" }],
}));

mock.module("ai", () => ({
  generateText: generateTextMock,
}));

mock.module("../local-mode", () => ({
  isLocalMode: (...args: unknown[]) => isLocalModeMock(...args),
}));

mock.module("../local-model", () => ({
  resolveChatModel: (...args: unknown[]) => resolveChatModelMock(...args),
}));

mock.module("../local-tools", () => ({
  executeLocalTool: (...args: unknown[]) => executeLocalToolMock(...args),
}));

mock.module("../subagent-stream-transport", () => ({
  postSubagentChatStream: (...args: unknown[]) => postSubagentChatStreamMock(...args),
  consumeSubagentStream: (...args: unknown[]) => consumeSubagentStreamMock(...args),
}));

describe("runSubagent (D-03, D-07, D-10)", () => {
  beforeEach(() => {
    generateTextMock.mockClear();
    isLocalModeMock.mockReturnValue(true);
    postSubagentChatStreamMock.mockClear();
    consumeSubagentStreamMock.mockClear();
    executeLocalToolMock.mockClear();
    resolveChatModelMock.mockReset();
    resolveChatModelMock.mockReturnValue({
      model: {} as unknown,
      providerOptions: undefined,
    });
  });

  test("returns summary-only result without inner messages array (D-03)", async () => {
    const result = await runSubagent({
      subagent_type: "explore",
      prompt: "Find auth handlers",
      mode: "BUILD",
      abortSignal: undefined,
    });

    expect(result.summary).toBe("Subagent completed: found 3 auth handlers.");
    expect(result).not.toHaveProperty("messages");
    expect(Object.keys(result)).not.toContain("messages");
  });

  test("passes stopWhen cap of 25 steps to generateText (D-07)", async () => {
    await runSubagent({
      subagent_type: "explore",
      prompt: "Scan codebase",
      mode: "BUILD",
      abortSignal: undefined,
    });

    expect(generateTextMock).toHaveBeenCalled();
    const call = generateTextMock.mock.calls[0]?.[0] as { stopWhen?: unknown };
    expect(call.stopWhen).toBeDefined();

    const stopWhen = call.stopWhen as { stepCount?: number; maxSteps?: number } | ((args: { steps: unknown[] }) => boolean);
    if (typeof stopWhen === "function") {
      const steps = Array.from({ length: 25 }, () => ({}));
      expect(stopWhen({ steps })).toBe(true);
      expect(stopWhen({ steps: steps.slice(0, 24) })).toBe(false);
    } else {
      expect(stopWhen.stepCount ?? stopWhen.maxSteps).toBe(25);
    }
  });

  test("abortSignal returns interrupted summary (D-10)", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runSubagent({
      subagent_type: "plan-research",
      prompt: "Compare options",
      mode: "PLAN",
      abortSignal: controller.signal,
    });

    expect(result.summary.toLowerCase()).toMatch(/interrupt/);
    expect(result.interrupted).toBe(true);
  });

  test("SaaS session path uses persist:false stream transport and returns summary", async () => {
    isLocalModeMock.mockReturnValue(false);

    const result = await runSubagent({
      subagent_type: "explore",
      prompt: "cli文件夹内容是什么？",
      mode: "BUILD",
      sessionId: "sess-saas-1",
      abortSignal: undefined,
    });

    expect(result.summary).toBe("packages/cli contains src and package.json");
    expect(postSubagentChatStreamMock).toHaveBeenCalled();
    expect(consumeSubagentStreamMock).toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
    const body = postSubagentChatStreamMock.mock.calls[0]?.[1] as {
      messages?: Array<{ parts?: Array<{ type?: string; text?: string }> }>;
    };
    const firstText = body.messages?.[0]?.parts?.[0]?.text ?? "";
    expect(firstText).toContain("You are a MoCode subagent");
    expect(firstText).toContain("# User task");
  });

  test("SaaS path keeps previous non-empty summary when final assistant has no text", async () => {
    isLocalModeMock.mockReturnValue(false);
    consumeSubagentStreamMock
      .mockResolvedValueOnce({
        id: "assistant-1",
        role: "assistant",
        parts: [
          { type: "text", text: "packages has cli, server, shared" },
          {
            type: "tool-readFile",
            toolCallId: "tool-1",
            state: "input-available",
            input: { path: "/tmp/a.ts" },
          },
        ],
      })
      .mockResolvedValueOnce({
        id: "assistant-2",
        role: "assistant",
        parts: [],
      });

    const result = await runSubagent({
      subagent_type: "explore",
      prompt: "这个packages文件夹的内容",
      mode: "BUILD",
      sessionId: "sess-saas-2",
      abortSignal: undefined,
    });

    expect(result.summary).toBe("packages has cli, server, shared");
    expect(postSubagentChatStreamMock).toHaveBeenCalledTimes(2);
    expect(executeLocalToolMock).toHaveBeenCalled();
  });

  test("SaaS path falls back to tool output summary when assistant text is empty", async () => {
    isLocalModeMock.mockReturnValue(false);
    consumeSubagentStreamMock.mockResolvedValueOnce({
      id: "assistant-3",
      role: "assistant",
      parts: [
        {
          type: "tool-listDirectory",
          toolCallId: "tool-2",
          state: "output-available",
          output: { entries: ["packages/cli", "packages/server", "packages/shared"] },
        },
      ],
    });

    const result = await runSubagent({
      subagent_type: "explore",
      prompt: "这个packages文件夹的内容",
      mode: "BUILD",
      sessionId: "sess-saas-3",
      abortSignal: undefined,
    });

    expect(result.summary).toContain("packages/cli");
    expect(result.summary).not.toBe("Subagent finished without a text summary.");
  });

  test("returns fallback summary when generateText text is empty", async () => {
    generateTextMock.mockImplementation(async () => ({
      text: "   ",
      steps: [{}],
    }));

    const result = await runSubagent({
      subagent_type: "explore",
      prompt: "scan packages",
      mode: "BUILD",
      abortSignal: undefined,
    });

    expect(result.summary).toBe("Task completed: scan packages");
  });

  test("returns model resolution error instead of calling generateText", async () => {
    resolveChatModelMock.mockImplementation(() => {
      throw new Error("Missing API key. Run /keys");
    });

    const result = await runSubagent({
      subagent_type: "explore",
      prompt: "scan",
      mode: "BUILD",
      model: "gpt-4.1",
      abortSignal: undefined,
    });

    expect(result.error).toBe(true);
    expect(result.summary).toContain("Missing API key");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  test("SaaS path falls back to prompt summary when no text and no tool output", async () => {
    isLocalModeMock.mockReturnValue(false);
    executeLocalToolMock.mockResolvedValueOnce({
      path: "packages",
      entries: [
        { name: "cli", type: "directory" },
        { name: "server", type: "directory" },
        { name: "shared", type: "directory" },
      ],
    });
    consumeSubagentStreamMock.mockResolvedValueOnce({
      id: "assistant-4",
      role: "assistant",
      parts: [],
    });

    const result = await runSubagent({
      subagent_type: "explore",
      prompt: "这个packages文件夹的内容",
      mode: "BUILD",
      sessionId: "sess-saas-4",
      abortSignal: undefined,
    });

    expect(result.summary).toContain("packages directories:");
    expect(result.summary).toContain("cli");
  });
});
