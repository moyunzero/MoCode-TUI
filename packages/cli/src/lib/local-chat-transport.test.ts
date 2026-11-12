import { describe, expect, test, mock, beforeEach } from "bun:test";
import { Mode } from "@mocode/shared";
import type { ToolSet } from "ai";
import type { McpManager } from "../mcp/manager";

let lastStreamTextTools: ToolSet | undefined;

const streamTextMock = mock((args: { tools: ToolSet }) => {
  lastStreamTextTools = args.tools;
  return {
    toUIMessageStream: () =>
      new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
  };
});

mock.module("ai", () => ({
  streamText: streamTextMock,
  validateUIMessages: async ({ messages }: { messages: unknown[] }) => messages,
  convertToModelMessages: async (messages: unknown[]) => messages,
}));

const { LocalChatTransport, stripIncompleteAssistantMessages } = await import("./local-chat-transport");

function createMockManager(): McpManager {
  const registered = [
    {
      serverName: "filesystem",
      tools: [{ name: "read_file", description: "Read file", inputSchema: {} }],
    },
  ];
  return {
    getDiscoveredTools: () => registered,
    getRegisteredTools: () => registered,
  } as unknown as McpManager;
}

function createMockResolvedModel() {
  return {
    model: {} as never,
    provider: "anthropic" as const,
    modelId: "claude-sonnet-4-6" as const,
  };
}

/** Minimal sendMessages args for a single user turn on `model`. */
function sendArgs(model: string, chatId = "session-1") {
  return {
    trigger: "submit-message" as const,
    chatId,
    messageId: undefined,
    messages: [
      {
        id: "msg-1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hello" }],
        metadata: { mode: Mode.BUILD, model },
      },
    ],
    abortSignal: undefined,
  };
}

async function drain(stream: ReadableStream) {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe("LocalChatTransport failover (BYOK)", () => {
  test("retries the next model when the primary provider is blocked", async () => {
    const downgrades: Array<{ from: string; to: string }> = [];
    const transport = new LocalChatTransport({
      resolveModel: (modelId) => {
        if (modelId === "gpt-oss-120b") {
          throw Object.assign(new Error("blocked"), { statusCode: 403 });
        }
        return createMockResolvedModel();
      },
      getMcpManager: createMockManager,
      buildSystemPrompt: () => "test system prompt",
      allowFailover: true,
      attemptsPerModel: 1,
      onDowngrade: (info) => downgrades.push(info),
    });

    const stream = await transport.sendMessages(sendArgs("gpt-oss-120b"));
    await drain(stream);

    expect(downgrades).toEqual([{ from: "gpt-oss-120b", to: "deepseek-flash" }]);
  });

  test("does not fall back on a non-retryable failure", async () => {
    const transport = new LocalChatTransport({
      resolveModel: () => {
        throw Object.assign(new Error("bad request"), { statusCode: 400 });
      },
      getMcpManager: createMockManager,
      buildSystemPrompt: () => "test system prompt",
    });

    await expect(transport.sendMessages(sendArgs("gpt-oss-120b"))).rejects.toThrow("bad request");
  });

  test("reports every failed attempt before succeeding", async () => {
    const failures: string[] = [];
    const transport = new LocalChatTransport({
      resolveModel: (modelId) => {
        if (modelId !== "deepseek-flash") {
          throw Object.assign(new Error("blocked"), { statusCode: 403 });
        }
        return createMockResolvedModel();
      },
      getMcpManager: createMockManager,
      buildSystemPrompt: () => "test system prompt",
      allowFailover: true,
      attemptsPerModel: 1,
      onAttemptFailed: ({ modelId, decision }) => failures.push(`${modelId}:${decision.detail}`),
    });

    await drain(await transport.sendMessages(sendArgs("claude-opus-4-6")));

    expect(failures).toEqual(["claude-opus-4-6:HTTP 403"]);
  });

  test("fails over when the stream emits start then a provider error", async () => {
    const downgrades: Array<{ from: string; to: string }> = [];
    streamTextMock.mockClear();

    streamTextMock
      .mockImplementationOnce(() => ({
        toUIMessageStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "start" });
              controller.enqueue({ type: "error", errorText: "Forbidden" });
              controller.close();
            },
          }),
      }))
      .mockImplementationOnce(() => ({
        toUIMessageStream: () =>
          new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "start" });
              controller.enqueue({ type: "text-delta", id: "t1", delta: "recovered" });
              controller.close();
            },
          }),
      }));

    const transport = new LocalChatTransport({
      resolveModel: () => createMockResolvedModel(),
      getMcpManager: createMockManager,
      buildSystemPrompt: () => "test system prompt",
      allowFailover: true,
      attemptsPerModel: 1,
      onDowngrade: (info) => downgrades.push(info),
    });

    const chunks: unknown[] = [];
    const stream = await transport.sendMessages(sendArgs("gpt-oss-120b"));
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    expect(streamTextMock.mock.calls.length).toBe(2);
    expect(downgrades).toEqual([{ from: "gpt-oss-120b", to: "deepseek-flash" }]);
    expect(chunks).toContainEqual({ type: "text-delta", id: "t1", delta: "recovered" });
  });
});

describe("LocalChatTransport", () => {
  beforeEach(() => {
    lastStreamTextTools = undefined;
    streamTextMock.mockClear();
  });

  test("sendMessages merges MCP tools with mcp__ prefix via buildMergedToolSet", async () => {
    const transport = new LocalChatTransport({
      resolveModel: () => createMockResolvedModel(),
      getMcpManager: createMockManager,
      buildSystemPrompt: () => "test system prompt",
    });

    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "session-1",
      messageId: undefined,
      messages: [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
          metadata: { mode: Mode.BUILD, model: "claude-sonnet-4-6" },
        },
      ],
      abortSignal: undefined,
    });

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(lastStreamTextTools).toBeDefined();
    expect(Object.keys(lastStreamTextTools ?? {})).toContain(
      "mcp__filesystem__read_file",
    );
    expect(Object.keys(lastStreamTextTools ?? {})).toContain("readFile");
  });

  test("does not use HTTP fetch for chat", async () => {
    const source = await import("./local-chat-transport");
    const sourceText = await Bun.file(
      new URL("./local-chat-transport.ts", import.meta.url),
    ).text();
    expect(sourceText).not.toContain("apiClient");
    expect(source.LocalChatTransport).toBeDefined();
  });

  test("stripIncompleteAssistantMessages removes failed stream placeholders", () => {
    const messages = [
      {
        id: "user-1",
        role: "user",
        parts: [{ type: "text", text: "hello" }],
      },
      {
        id: "assistant-1",
        role: "assistant",
        parts: [],
      },
      {
        id: "user-2",
        role: "user",
        parts: [{ type: "text", text: "retry" }],
      },
    ] as never;

    const stripped = stripIncompleteAssistantMessages(messages);
    expect(stripped).toHaveLength(2);
    expect(stripped.map((message) => message.id)).toEqual(["user-1", "user-2"]);
  });
});

describe("reconnectToStream (D-12 BYOK)", () => {
  test("returns non-null ReadableStream when sendMessages stream is still active", async () => {
    let keepOpen = true;
    streamTextMock.mockImplementationOnce(() => ({
      toUIMessageStream: () =>
        new ReadableStream({
          start(controller) {
            if (!keepOpen) {
              controller.close();
              return;
            }
            controller.enqueue({ type: "start" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "hi" });
          },
        }),
    }));

    const transport = new LocalChatTransport({
      resolveModel: () => createMockResolvedModel(),
      getMcpManager: createMockManager,
      buildSystemPrompt: () => "test system prompt",
    });

    const _stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "session-reconnect",
      messageId: undefined,
      messages: [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
          metadata: { mode: Mode.BUILD, model: "claude-sonnet-4-6" },
        },
      ],
      abortSignal: undefined,
    });

    const reconnected = await transport.reconnectToStream({ chatId: "session-reconnect" });
    expect(reconnected).not.toBeNull();
    expect(reconnected).toBeInstanceOf(ReadableStream);

    keepOpen = false;
  });

  test("returns null after stream completes", async () => {
    const transport = new LocalChatTransport({
      resolveModel: () => createMockResolvedModel(),
      getMcpManager: createMockManager,
      buildSystemPrompt: () => "test system prompt",
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "session-done",
      messageId: undefined,
      messages: [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
          metadata: { mode: Mode.BUILD, model: "claude-sonnet-4-6" },
        },
      ],
      abortSignal: undefined,
    });

    const reader = stream.getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const reconnected = await transport.reconnectToStream({ chatId: "session-done" });
    expect(reconnected).toBeNull();
  });

  test("returns null when reconnect chatId does not match active stream", async () => {
    streamTextMock.mockImplementationOnce(() => ({
      toUIMessageStream: () =>
        new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "start" });
            controller.enqueue({ type: "text-delta", id: "t1", delta: "hi" });
          },
        }),
    }));

    const transport = new LocalChatTransport({
      resolveModel: () => createMockResolvedModel(),
      getMcpManager: createMockManager,
      buildSystemPrompt: () => "test system prompt",
    });

    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "session-a",
      messageId: undefined,
      messages: [
        {
          id: "msg-1",
          role: "user",
          parts: [{ type: "text", text: "hello" }],
          metadata: { mode: Mode.BUILD, model: "claude-sonnet-4-6" },
        },
      ],
      abortSignal: undefined,
    });

    const reconnected = await transport.reconnectToStream({ chatId: "session-b" });
    expect(reconnected).toBeNull();
  });
});
