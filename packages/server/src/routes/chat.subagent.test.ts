import { describe, expect, mock, test } from "bun:test";
import { resolveSubagentChatFinish } from "../lib/chat-subagent";

describe("chat subagent ephemeral persist (D-09)", () => {
  test("persist false skips db.session.update for subagent inner stream", async () => {
    const sessionUpdate = mock(async () => ({}));
    const ingestUsage = mock(async () => undefined);

    await resolveSubagentChatFinish({
      persist: false,
      sessionId: "session-1",
      userId: "user-1",
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "explore auth" }] },
        {
          id: "a1",
          role: "assistant",
          parts: [{ type: "tool-task", state: "output-available", output: { summary: "done" } }],
        },
      ],
      completedUsage: { totalTokens: 128 },
      db: { session: { update: sessionUpdate } },
      ingestAiUsage: ingestUsage,
    });

    expect(sessionUpdate).not.toHaveBeenCalled();
    expect(ingestUsage).toHaveBeenCalled();
  });

  test("persist true merges and updates session messages", async () => {
    const sessionUpdate = mock(async () => ({}));
    const ingestUsage = mock(async () => undefined);

    await resolveSubagentChatFinish({
      persist: true,
      sessionId: "session-1",
      userId: "user-1",
      messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      completedUsage: undefined,
      db: { session: { update: sessionUpdate } },
      ingestAiUsage: ingestUsage,
    });

    expect(sessionUpdate).toHaveBeenCalled();
  });
});
