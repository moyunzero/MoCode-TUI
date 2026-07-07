import { describe, expect, mock, test } from "bun:test";
import { postSubagentChatStream } from "./subagent-stream-transport";

describe("postSubagentChatStream", () => {
  test("posts ephemeral subagent request with persist false", async () => {
    const fetchMock = mock(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response("ok", { status: 200 }),
    );

    await postSubagentChatStream(
      { sessionId: "sess-1", fetchImpl: fetchMock as unknown as typeof fetch },
      {
        messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hello" }] }],
        mode: "BUILD",
        model: "claude-sonnet-4-6",
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(requestInit.body)) as { persist?: boolean; id?: string };
    expect(body.id).toBe("sess-1");
    expect(body.persist).toBe(false);
  });
});
