import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FALLBACK_CHAIN,
  retryDelayMs,
  buildModelChain,
  classifyFailover,
  runWithFailover,
} from "./provider-chain";

/** Error carrying an HTTP status, shaped like the providers' failures. */
function httpError(status: number): Error & { statusCode: number } {
  const error = new Error(`upstream failed with ${status}`) as Error & { statusCode: number };
  error.statusCode = status;
  return error;
}

function namedError(name: string, message = name): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("buildModelChain", () => {
  test("puts the primary first and appends fallbacks", () => {
    expect(buildModelChain("claude-opus-4-6")).toEqual(["claude-opus-4-6", "deepseek-flash"]);
  });

  test("drops the primary when it also appears in the fallback chain", () => {
    expect(buildModelChain("deepseek-flash")).toEqual(["deepseek-flash"]);
  });

  test("never retries the same model twice", () => {
    const chain = buildModelChain("a", ["a", "b", "a", "c"]);
    expect(chain).toEqual(["a", "b", "c"]);
    expect(new Set(chain).size).toBe(chain.length);
  });

  test("empty primary is ignored rather than attempted", () => {
    expect(buildModelChain("", ["b"])).toEqual(["b"]);
  });
});

describe("classifyFailover", () => {
  test("retries region blocks and auth failures — another provider may work", () => {
    for (const status of [401, 403, 429, 502, 503]) {
      const decision = classifyFailover(httpError(status));
      expect(decision.retryable).toBe(true);
      expect(decision.kind).toBe("http");
      expect(decision.detail).toBe(`HTTP ${status}`);
    }
  });

  test("does NOT retry a 400 — that is our own malformed request", () => {
    expect(classifyFailover(httpError(400)).retryable).toBe(false);
  });

  test("does NOT retry a user abort — Esc must stay cancelled", () => {
    const decision = classifyFailover(namedError("AbortError"));
    expect(decision).toMatchObject({ retryable: false, retrySameProvider: false, kind: "abort" });
  });

  test("retries a timeout — a hung provider should not end the turn", () => {
    expect(classifyFailover(namedError("TimeoutError")).retryable).toBe(true);
  });

  test("retries connection-level failures", () => {
    expect(classifyFailover(new Error("fetch failed")).kind).toBe("network");
    expect(classifyFailover(new Error("connect ECONNREFUSED 127.0.0.1:443")).retryable).toBe(true);
  });

  test("unknown errors are not retried", () => {
    expect(classifyFailover(new Error("boom")).retryable).toBe(false);
  });

  test("reads status from a fetch-style response object", () => {
    expect(classifyFailover({ response: { status: 403 } }).detail).toBe("HTTP 403");
  });
});

describe("runWithFailover", () => {
  test("returns the primary result without a downgrade when it works", async () => {
    const outcome = await runWithFailover({
      primary: "deepseek-flash",
      consent: true,
      attempt: async (modelId) => `answer from ${modelId}`,
    });

    expect(outcome.value).toBe("answer from deepseek-flash");
    expect(outcome.modelId).toBe("deepseek-flash");
    expect(outcome.downgradedFrom).toBeNull();
    expect(outcome.failures).toEqual([]);
  });

  test("falls through a blocked provider and reports the downgrade", async () => {
    const outcome = await runWithFailover({
      primary: "gpt-oss-120b",
      consent: true,
      attempt: async (modelId) => {
        if (modelId === "gpt-oss-120b") throw httpError(403);
        return `answer from ${modelId}`;
      },
    });

    expect(outcome.value).toBe("answer from deepseek-flash");
    expect(outcome.downgradedFrom).toBe("gpt-oss-120b");
    expect(outcome.failures).toEqual([{ modelId: "gpt-oss-120b", detail: "HTTP 403" }]);
  });

  test("tries every candidate before giving up, then rethrows the last error", async () => {
    const tried: string[] = [];

    await expect(
      runWithFailover({
        primary: "a",
        consent: true,
        fallbacks: ["b", "c"],
        attemptsPerModel: 1,
        attempt: async (modelId) => {
          tried.push(modelId);
          throw httpError(503);
        },
      }),
    ).rejects.toThrow("upstream failed with 503");

    expect(tried).toEqual(["a", "b", "c"]);
  });

  test("stops immediately on a non-retryable failure", async () => {
    const tried: string[] = [];

    await expect(
      runWithFailover({
        primary: "a",
        consent: true,
        fallbacks: ["b"],
        attempt: async (modelId) => {
          tried.push(modelId);
          throw httpError(400);
        },
      }),
    ).rejects.toThrow("upstream failed with 400");

    expect(tried).toEqual(["a"]);
  });

  test("does not burn the chain when the user aborts", async () => {
    const tried: string[] = [];

    await expect(
      runWithFailover({
        primary: "a",
        consent: true,
        fallbacks: ["b"],
        attempt: async (modelId) => {
          tried.push(modelId);
          throw namedError("AbortError");
        },
      }),
    ).rejects.toThrow();

    expect(tried).toEqual(["a"]);
  });

  test("reports every failed attempt to the caller", async () => {
    const events: string[] = [];

    await runWithFailover({
      primary: "a",
      consent: true,
      fallbacks: ["b", "c"],
      attemptsPerModel: 1,
      attempt: async (modelId) => {
        if (modelId !== "c") throw httpError(403);
        return "ok";
      },
      onAttemptFailed: ({ modelId, decision }) => events.push(`${modelId}:${decision.detail}`),
    });

    expect(events).toEqual(["a:HTTP 403", "b:HTTP 403"]);
  });

  test("default chain starts with the reachable provider", () => {
    expect(DEFAULT_FALLBACK_CHAIN[0]).toBe("deepseek-flash");
  });

  test("the 4x-cost model is NOT a default fallback", () => {
    // Silently escalating someone's spend is not this code's call.
    expect(DEFAULT_FALLBACK_CHAIN).not.toContain("deepseek-v4-pro");
  });

  test("failover requires explicit consent", async () => {
    const tried: string[] = [];

    await expect(
      runWithFailover({
        primary: "gpt-oss-120b",
        consent: false,
        attemptsPerModel: 1,
        attempt: async (modelId) => {
          tried.push(modelId);
          throw httpError(403);
        },
      }),
    ).rejects.toThrow();

    expect(tried).toEqual(["gpt-oss-120b"]);
  });
});

describe("retries keep a valid key sufficient", () => {
  const noWait = async () => {};

  test("a transient failure is retried and the turn completes", async () => {
    let calls = 0;

    const outcome = await runWithFailover({
      primary: "deepseek-flash",
      consent: false,
      attemptsPerModel: 3,
      sleep: noWait,
      attempt: async (modelId) => {
        calls += 1;
        if (calls < 3) throw httpError(429);
        return `ok from ${modelId}`;
      },
    });

    expect(outcome.value).toBe("ok from deepseek-flash");
    expect(calls).toBe(3);
  });

  test("exhausting retries surfaces the last error", async () => {
    let calls = 0;

    await expect(
      runWithFailover({
        primary: "deepseek-flash",
        consent: false,
        attemptsPerModel: 2,
        sleep: noWait,
        attempt: async () => {
          calls += 1;
          throw httpError(503);
        },
      }),
    ).rejects.toThrow("upstream failed with 503");

    expect(calls).toBe(2);
  });

  test("a non-retryable error is not retried", async () => {
    let calls = 0;

    await expect(
      runWithFailover({
        primary: "deepseek-flash",
        consent: false,
        attemptsPerModel: 3,
        sleep: noWait,
        attempt: async () => {
          calls += 1;
          throw httpError(400);
        },
      }),
    ).rejects.toThrow();

    expect(calls).toBe(1);
  });

  test("A timeout is retried — a stalled stream is not the user's fault", async () => {
    let calls = 0;

    await runWithFailover({
      primary: "deepseek-flash",
      consent: false,
      attemptsPerModel: 2,
      sleep: noWait,
      attempt: async () => {
        calls += 1;
        if (calls === 1) throw namedError("TimeoutError");
        return "recovered";
      },
    });

    expect(calls).toBe(2);
  });

  test("backoff grows and stays bounded", () => {
    expect(retryDelayMs(1, 500)).toBeLessThan(1_001);
    expect(retryDelayMs(2, 500)).toBeLessThan(1_501);
    expect(retryDelayMs(10, 500)).toBeLessThanOrEqual(8_500);
  });
});
