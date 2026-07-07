import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { consumeSubagentStream, postSubagentChatStream } from "./subagent-stream-transport";

describe("postSubagentChatStream", () => {
  test("posts ephemeral subagent request with persist false", async () => {
    const fetchMock = mockFetch(async () => new Response("ok", { status: 200 }));

    await postSubagentChatStream(
      { sessionId: "sess-1", fetchImpl: fetchMock },
      {
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }],
        mode: "BUILD",
        model: "claude-sonnet-4-6",
      },
    );

    expect(fetchMock.calls).toHaveLength(1);
    const requestInit = fetchMock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { persist?: boolean; id?: string };
    expect(body.id).toBe("sess-1");
    expect(body.persist).toBe(false);
  });
});

describe("consumeSubagentStream", () => {
  test("returns original assistant message when response has no body", async () => {
    const original: UIMessage = {
      id: "assistant-1",
      role: "assistant",
      parts: [{ type: "text", text: "partial" }],
    };

    const result = await consumeSubagentStream(new Response(null, { status: 200 }), original);
    expect(result).toBe(original);
  });
});

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init]);
    return handler(input, init);
  }) as typeof fetch;
  return Object.assign(fetchImpl, { calls });
}
