import { afterAll, describe, expect, test } from "bun:test";
import { createFailoverFetch } from "./chat-fetch";
import { HttpError } from "./http-errors";

const readError = async (response: Response) => {
  try {
    const data = (await response.json()) as { error?: string };
    return data.error ?? `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
};

/** Records every call so tests can assert on the rewritten body. */
function makeFetch(responses: Array<Response | (() => Response)>) {
  const calls: Array<{ url: string; body: unknown }> = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let body: unknown = init?.body;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url: String(input), body });

    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch call");
    return typeof next === "function" ? next() : next;
  }) as typeof globalThis.fetch;

  return { fetchImpl, calls };
}

function chatInit(model: string) {
  return {
    method: "POST",
    body: JSON.stringify({ id: "session-1", model, mode: "build", messages: [] }),
  } satisfies RequestInit;
}

/** Build a 200 SSE response shaped like the server's UI message stream. */
function sseResponse(events: Array<Record<string, unknown>>): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("createFailoverFetch", () => {
  test("returns the primary response without reporting a downgrade", async () => {
    const { fetchImpl, calls } = makeFetch([new Response("ok", { status: 200 })]);
    const downgrades: unknown[] = [];

    const fetchWithFallback = createFailoverFetch({
      allowFailover: true,
      attemptsPerModel: 1,
      fetchImpl,
      readError,
      onDowngrade: (info) => downgrades.push(info),
    });

    const response = await fetchWithFallback("http://localhost:3000/chat", chatInit("deepseek-flash"));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(downgrades).toEqual([]);
  });

  test("retries on 403 and reports the downgrade explicitly", async () => {
    const { fetchImpl, calls } = makeFetch([
      new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 }),
      new Response("ok", { status: 200 }),
    ]);
    const downgrades: Array<{ from: string; to: string }> = [];

    const fetchWithFallback = createFailoverFetch({
      allowFailover: true,
      attemptsPerModel: 1,
      fetchImpl,
      readError,
      onDowngrade: (info) => downgrades.push(info),
    });

    const response = await fetchWithFallback("http://localhost:3000/chat", chatInit("gpt-oss-120b"));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    // Second attempt must ask the server for the fallback model, nothing else changes.
    expect(calls[1]?.body).toMatchObject({ model: "deepseek-flash", id: "session-1", mode: "build" });
    expect(downgrades).toEqual([
      {
        from: "gpt-oss-120b",
        to: "deepseek-flash",
        failures: [{ modelId: "gpt-oss-120b", detail: "HTTP 403" }],
      },
    ]);
  });

  test("does not retry a 400 — the request itself is wrong", async () => {
    const { fetchImpl, calls } = makeFetch([
      new Response(JSON.stringify({ error: "Invalid request body" }), { status: 400 }),
    ]);

    const fetchWithFallback = createFailoverFetch({ allowFailover: true, attemptsPerModel: 1, fetchImpl, readError });

    await expect(
      fetchWithFallback("http://localhost:3000/chat", chatInit("deepseek-flash")),
    ).rejects.toBeInstanceOf(HttpError);

    expect(calls).toHaveLength(1);
  });

  test("throws the last failure when every candidate is blocked", async () => {
    const { fetchImpl, calls } = makeFetch([
      new Response("", { status: 403 }),
      new Response("", { status: 403 }),
      new Response("", { status: 403 }),
    ]);

    const fetchWithFallback = createFailoverFetch({ allowFailover: true, attemptsPerModel: 1, fetchImpl, readError });

    await expect(
      fetchWithFallback("http://localhost:3000/chat", chatInit("gpt-oss-120b")),
    ).rejects.toBeInstanceOf(HttpError);

    // Default chain is flash only: Pro costs ~4x and is never auto-escalated.
    expect(calls.map((call) => (call.body as { model: string }).model)).toEqual([
      "gpt-oss-120b",
      "deepseek-flash",
    ]);
  });

  test("passes through requests it cannot fail over", async () => {
    const { fetchImpl, calls } = makeFetch([
      new Response("ok", { status: 200 }),
      new Response("ok", { status: 200 }),
    ]);
    const fetchWithFallback = createFailoverFetch({ allowFailover: true, attemptsPerModel: 1, fetchImpl, readError });

    await fetchWithFallback("http://localhost:3000/chat", { method: "POST", body: "not-json" });
    await fetchWithFallback("http://localhost:3000/chat", {
      method: "POST",
      body: JSON.stringify({ id: "x" }),
    });

    expect(calls).toHaveLength(2);
  });

  test("fails over when the server reports the provider error inside a 200 stream", async () => {
    // This is the real shape: the server answers 200 and streams the upstream
    // failure as an `error` event, so `response.ok` is true and a status-only
    // check would never retry.
    const { fetchImpl, calls } = makeFetch([
      sseResponse([{ type: "start" }, { type: "error", errorText: "Forbidden" }]),
      sseResponse([
        { type: "start" },
        { type: "text-delta", delta: "recovered" },
        { type: "finish" },
      ]),
    ]);
    const downgrades: Array<{ from: string; to: string }> = [];

    const fetchWithFallback = createFailoverFetch({
      allowFailover: true,
      attemptsPerModel: 1,
      fetchImpl,
      readError,
      onDowngrade: (info) => downgrades.push(info),
    });

    const response = await fetchWithFallback(
      "http://localhost:3000/chat",
      chatInit("gpt-oss-120b"),
    );

    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ model: "deepseek-flash" });
    expect(downgrades[0]).toMatchObject({ from: "gpt-oss-120b", to: "deepseek-flash" });
    expect(await response.text()).toContain("recovered");
  });

  test("a healthy stream is returned byte-for-byte, nothing lost by peeking", async () => {
    const events = [
      { type: "start" },
      { type: "text-delta", delta: "hello" },
      { type: "text-delta", delta: " world" },
      { type: "finish" },
    ];
    const expected = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");

    const { fetchImpl, calls } = makeFetch([sseResponse(events)]);
    const fetchWithFallback = createFailoverFetch({ allowFailover: true, attemptsPerModel: 1, fetchImpl, readError });

    const response = await fetchWithFallback(
      "http://localhost:3000/chat",
      chatInit("deepseek-flash"),
    );

    expect(calls).toHaveLength(1);
    expect(await response.text()).toBe(expected);
  });

  test("user abort is classified as AbortError, not a retryable HttpError", async () => {
    const user = new AbortController();
    user.abort();

    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      // Simulate a racing 403 that arrives as the user hits Esc.
      if (init?.signal?.aborted) {
        throw new HttpError(403, "Forbidden");
      }
      return new Response("ok", { status: 200 });
    }) as typeof globalThis.fetch;

    const fetchWithFallback = createFailoverFetch({ allowFailover: true, attemptsPerModel: 1, fetchImpl, readError });

    await expect(
      fetchWithFallback("http://localhost:3000/chat", {
        ...chatInit("deepseek-flash"),
        signal: user.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  test("an SSE body that closes before any output fails over", async () => {
    const { fetchImpl, calls } = makeFetch([
      sseResponse([{ type: "start" }]),
      sseResponse([{ type: "start" }, { type: "text-delta", delta: "recovered" }, { type: "finish" }]),
    ]);

    const fetchWithFallback = createFailoverFetch({
      allowFailover: true,
      attemptsPerModel: 1,
      fetchImpl,
      readError,
    });

    const response = await fetchWithFallback(
      "http://localhost:3000/chat",
      chatInit("gpt-oss-120b"),
    );

    expect(calls).toHaveLength(2);
    expect(await response.text()).toContain("recovered");
  });

  test("without consent the turn is never sent to another provider", async () => {
    const { fetchImpl, calls } = makeFetch([new Response("", { status: 403 })]);

    const fetchWithFallback = createFailoverFetch({ fetchImpl, readError });

    await expect(
      fetchWithFallback("http://localhost:3000/chat", chatInit("gpt-oss-120b")),
    ).rejects.toBeInstanceOf(HttpError);

    // Exactly one attempt: the user did not authorise another vendor.
    expect(calls).toHaveLength(1);
  });

  test("a healthy long stream is not killed by the per-attempt deadline", async () => {
    // Regression: the deadline used to cover the whole stream, so any turn longer
    // than the timeout died mid-reply with "The operation timed out".
    const encoder = new TextEncoder();
    const event = (payload: Record<string, unknown>) =>
      encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(event({ type: "start" }));
            controller.enqueue(event({ type: "text-delta", delta: "first" }));
            await new Promise((resolve) => setTimeout(resolve, 150));
            controller.enqueue(event({ type: "text-delta", delta: "late" }));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof globalThis.fetch;

    const fetchWithFallback = createFailoverFetch({
      allowFailover: true,
      attemptsPerModel: 1,
      fetchImpl,
      readError,
      attemptTimeoutMs: 50,
    });

    const response = await fetchWithFallback(
      "http://localhost:3000/chat",
      chatInit("deepseek-flash"),
    );
    const text = await response.text();

    expect(text).toContain("first");
    // This chunk arrives well after the 50ms deadline; it must still be delivered.
    expect(text).toContain("late");
  });
});

describe("deadline policy", () => {
  const original = process.env.MOCODE_CONNECT_TIMEOUT_MS;
  const originalStall = process.env.MOCODE_STALL_TIMEOUT_MS;

  afterAll(() => {
    if (original === undefined) delete process.env.MOCODE_CONNECT_TIMEOUT_MS;
    else process.env.MOCODE_CONNECT_TIMEOUT_MS = original;
    if (originalStall === undefined) delete process.env.MOCODE_STALL_TIMEOUT_MS;
    else process.env.MOCODE_STALL_TIMEOUT_MS = originalStall;
  });

  test("connect budget defaults to 20s", async () => {
    const { connectTimeoutMs } = await import("./chat-fetch");
    delete process.env.MOCODE_CONNECT_TIMEOUT_MS;
    expect(connectTimeoutMs()).toBe(20_000);
  });

  test("stall budget defaults to 120s — it bounds silence, not generation", async () => {
    const { stallTimeoutMs } = await import("./chat-fetch");
    delete process.env.MOCODE_STALL_TIMEOUT_MS;
    expect(stallTimeoutMs()).toBe(120_000);
  });

  test("both are overridable", async () => {
    const { connectTimeoutMs, stallTimeoutMs } = await import("./chat-fetch");
    process.env.MOCODE_CONNECT_TIMEOUT_MS = "3000";
    process.env.MOCODE_STALL_TIMEOUT_MS = "5000";
    expect(connectTimeoutMs()).toBe(3_000);
    expect(stallTimeoutMs()).toBe(5_000);
  });

  test("nonsense values fall back instead of producing a zero budget", async () => {
    const { connectTimeoutMs, stallTimeoutMs } = await import("./chat-fetch");
    process.env.MOCODE_CONNECT_TIMEOUT_MS = "-1";
    process.env.MOCODE_STALL_TIMEOUT_MS = "abc";
    expect(connectTimeoutMs()).toBe(20_000);
    expect(stallTimeoutMs()).toBe(120_000);
  });
});

describe("a slow but alive stream is never killed", () => {
  test("chunks trickling in with gaps under the stall budget complete normally", async () => {
    const encoder = new TextEncoder();
    const event = (payload: Record<string, unknown>) =>
      encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

    // Total duration ~450ms, well past the 120ms stall budget — but no single gap is.
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(event({ type: "start" }));
            for (const piece of ["a", "b", "c", "d", "e"]) {
              await new Promise((resolve) => setTimeout(resolve, 80));
              controller.enqueue(event({ type: "text-delta", delta: piece }));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      )) as typeof globalThis.fetch;

    const fetchWithFallback = createFailoverFetch({
      allowFailover: true,
      attemptsPerModel: 1,
      fetchImpl,
      readError,
      stallTimeoutMs: 120,
    });

    const response = await fetchWithFallback(
      "http://localhost:3000/chat",
      chatInit("deepseek-flash"),
    );
    const text = await response.text();

    expect(text).toContain("text-delta");
  });
});
