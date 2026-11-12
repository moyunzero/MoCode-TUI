import { describe, expect, test } from "bun:test";
import {
  DEFAULT_COMPACTION_POLICY,
  compactMessages,
  estimateMessageTokens,
  estimateMessagesTokens,
  estimateTextTokens,
} from "./context-compaction";

type Msg = { id: string; role: string; parts: unknown[] };

function user(id: string, text: string): Msg {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistantText(id: string, text: string): Msg {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function assistantTool(id: string, name: string, input: unknown, output: string): Msg {
  return {
    id,
    role: "assistant",
    parts: [
      { type: `tool-${name}`, input, output },
      { type: "text", text: `called ${name}` },
    ],
  };
}

describe("estimateTextTokens", () => {
  test("empty text is free", () => {
    expect(estimateTextTokens("")).toBe(0);
  });

  test("ascii is roughly 4 chars per token", () => {
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("a".repeat(400))).toBe(100);
  });

  test("cjk costs about one token per character", () => {
    expect(estimateTextTokens("修仙欠费中")).toBe(5);
  });

  test("mixed content adds both", () => {
    expect(estimateTextTokens("abcd修仙")).toBe(3);
  });
});

describe("estimateMessageTokens", () => {
  test("counts text parts", () => {
    expect(estimateMessageTokens(user("u", "hello world"))).toBeGreaterThan(0);
  });

  test("counts tool input and output payloads", () => {
    const small = estimateMessageTokens(assistantTool("a", "readFile", { path: "a.ts" }, "x"));
    const large = estimateMessageTokens(
      assistantTool("a", "readFile", { path: "a.ts" }, "x".repeat(4_000)),
    );

    expect(large).toBeGreaterThan(small);
  });

  test("a message with no parts costs nothing", () => {
    expect(estimateMessageTokens({ id: "x", role: "user" })).toBe(0);
  });

  test("conversation total is the sum", () => {
    const messages = [user("u", "abcd"), assistantText("a", "abcd")];
    expect(estimateMessagesTokens(messages)).toBe(
      estimateMessageTokens(messages[0]!) + estimateMessageTokens(messages[1]!),
    );
  });
});

/** 20 turns of realistic, token-heavy history. */
function longConversation(): Msg[] {
  const messages: Msg[] = [];

  for (let turn = 0; turn < 20; turn += 1) {
    messages.push(user(`u${turn}`, `请检查第 ${turn} 个文件并说明问题`.padEnd(200, "。")));
    messages.push(
      assistantTool(
        `a${turn}`,
        turn % 2 === 0 ? "bash" : "readFile",
        { path: `src/module-${turn}.ts`, command: "ls" },
        "x".repeat(2_000),
      ),
    );
  }

  return messages;
}

describe("compactMessages", () => {
  test("leaves a small conversation alone", () => {
    const messages = [user("u", "hi"), assistantText("a", "hello")];
    const result = compactMessages(messages);

    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
    expect(result.digest).toBeNull();
  });

  test("does not compact when the message count is still low", () => {
    const messages = [user("u", "hi"), assistantText("a", "x".repeat(1_000_000))];
    const result = compactMessages(messages, { ...DEFAULT_COMPACTION_POLICY, maxTokens: 10 });

    expect(result.compacted).toBe(false);
  });

  test("folds old turns once the budget is exceeded", () => {
    const messages = longConversation();
    const result = compactMessages(messages, {
      ...DEFAULT_COMPACTION_POLICY,
      maxTokens: 1_000,
      keepRecent: 6,
      minMessages: 8,
    });

    expect(result.compacted).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  test("keeps the most recent messages verbatim", () => {
    const messages = longConversation();
    const result = compactMessages(messages, {
      ...DEFAULT_COMPACTION_POLICY,
      maxTokens: 1_000,
      keepRecent: 4,
      minMessages: 8,
    });

    const kept = result.messages.slice(1);
    expect(kept).toEqual(messages.slice(messages.length - kept.length));
  });

  test("never splits a user turn from what followed it", () => {
    const messages = longConversation();
    const result = compactMessages(messages, {
      ...DEFAULT_COMPACTION_POLICY,
      maxTokens: 1_000,
      keepRecent: 7,
      minMessages: 8,
    });

    // Index 0 is the digest; everything after it must start on a user message.
    expect(result.messages[1]?.role).toBe("user");
  });

  test("never compacts when there is no user boundary to cut at", () => {
    // One opening user turn, then a long assistant-only tail: any cut would land
    // inside the active turn and drop the request that produced it.
    const messages: Msg[] = [user("u0", "开始")];
    for (let index = 1; index < 20; index += 1) {
      messages.push(assistantText(`a${index}`, "x".repeat(2_000)));
    }

    const result = compactMessages(messages, {
      ...DEFAULT_COMPACTION_POLICY,
      maxTokens: 100,
      keepRecent: 2,
      minMessages: 4,
    });

    expect(result.compacted).toBe(false);
  });

  test("digest records the tools and files the agent already touched", () => {
    const result = compactMessages(longConversation(), {
      ...DEFAULT_COMPACTION_POLICY,
      maxTokens: 1_000,
      keepRecent: 4,
      minMessages: 8,
    });

    expect(result.digest).toContain("[compacted]");
    expect(result.digest).toContain("Tools already used:");
    expect(result.digest).toMatch(/(bash|readFile)×\d+/);
    expect(result.digest).toContain("Files touched:");
    expect(result.digest).toContain("src/module-0.ts");
  });

  test("digest tells the model the content is gone, not that it was summarized", () => {
    const result = compactMessages(longConversation(), {
      ...DEFAULT_COMPACTION_POLICY,
      maxTokens: 1_000,
      keepRecent: 4,
      minMessages: 8,
    });

    expect(result.digest).toContain("re-read a file");
  });

  test("compaction is bounded — running twice does not compound", () => {
    const first = compactMessages(longConversation(), {
      ...DEFAULT_COMPACTION_POLICY,
      maxTokens: 1_000,
      keepRecent: 4,
      minMessages: 8,
    });

    const second = compactMessages(first.messages, {
      ...DEFAULT_COMPACTION_POLICY,
      maxTokens: 1_000,
      keepRecent: 4,
      minMessages: 8,
    });

    expect(second.tokensAfter).toBeLessThanOrEqual(first.tokensAfter);
  });
});
