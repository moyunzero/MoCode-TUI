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
  return {
    getDiscoveredTools: () => [
      {
        serverName: "filesystem",
        tools: [{ name: "read_file", description: "Read file", inputSchema: {} }],
      },
    ],
  } as unknown as McpManager;
}

function createMockResolvedModel() {
  return {
    model: {} as never,
    provider: "anthropic" as const,
    modelId: "claude-sonnet-4-6" as const,
  };
}

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
