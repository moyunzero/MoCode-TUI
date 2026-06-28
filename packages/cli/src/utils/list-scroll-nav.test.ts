import { describe, expect, test } from "bun:test";
import { streamingTranscriptScrollSignal } from "./list-scroll-nav";

describe("streamingTranscriptScrollSignal", () => {
  test("returns 0 when not loading", () => {
    expect(
      streamingTranscriptScrollSignal(false, [{ parts: [{ type: "text", text: "hello" }] }]),
    ).toBe(0);
  });

  test("grows when tail text lengthens without changing message count", () => {
    const oneToken = streamingTranscriptScrollSignal(true, [
      { parts: [{ type: "text", text: "hi" }] },
    ]);
    const moreTokens = streamingTranscriptScrollSignal(true, [
      { parts: [{ type: "text", text: "hello world" }] },
    ]);

    expect(moreTokens).toBeGreaterThan(oneToken);
  });

  test("increments when a new message is appended", () => {
    const single = streamingTranscriptScrollSignal(true, [
      { parts: [{ type: "text", text: "a" }] },
    ]);
    const pair = streamingTranscriptScrollSignal(true, [
      { parts: [{ type: "text", text: "a" }] },
      { parts: [{ type: "text", text: "b" }] },
    ]);

    expect(pair).toBeGreaterThan(single);
  });
});
