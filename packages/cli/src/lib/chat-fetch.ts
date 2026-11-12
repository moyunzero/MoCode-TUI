/**
 * Failover fetch for the SaaS chat transport.
 *
 * The server hard-binds one provider per model, so a region-blocked provider makes
 * `POST /chat` answer 403 and the whole turn dies. This wrapper retries the request
 * against the next model in the chain, rewriting only the `model` field of the body.
 *
 * Retry happens **before** any bytes stream: only a non-2xx response is retried, so a
 * stream that already started (and was already billed) is never replayed.
 *
 * The downgrade is reported to the caller, never applied silently.
 */
import type { SupportedChatModelId } from "@mocode/shared";
import { HttpError } from "./http-errors";
import { runWithFailover, type FailoverDecision } from "./provider-chain";

export type DowngradeInfo = {
  /** Model the user asked for. */
  from: string;
  /** Model that actually answered. */
  to: string;
  failures: Array<{ modelId: string; detail: string }>;
};

export type FailoverFetchOptions = {
  /** Injectable for tests. */
  fetchImpl?: typeof globalThis.fetch;
  /** Reads the `{ error }` envelope off a failed response. */
  readError: (response: Response) => Promise<string>;
  fallbacks?: readonly SupportedChatModelId[];
  /** Budget for connect + headers. Does NOT bound generation. */
  connectTimeoutMs?: number;
  /** @deprecated alias for {@link connectTimeoutMs}. */
  attemptTimeoutMs?: number;
  /** Silence budget while reading; reset on every chunk. */
  stallTimeoutMs?: number;
  /** Attempts per model; defaults to `MOCODE_PROVIDER_RETRIES` or 3. */
  attemptsPerModel?: number;
  /** Injectable for tests so they do not wait on real backoff. */
  sleep?: (ms: number) => Promise<void>;
  /** Explicit opt-in to trying another provider; see `FailoverOptions.consent`. */
  allowFailover?: boolean;
  onDowngrade?: (info: DowngradeInfo) => void;
  onAttemptFailed?: (event: { modelId: string; decision: FailoverDecision }) => void;
};

/**
 * Budget for *reaching the stream* — DNS, TCP, TLS, HTTP headers.
 *
 * This bounds the network, not the model. It is cleared the moment headers arrive,
 * because everything after that is generation and generation is allowed to be slow.
 */
export function connectTimeoutMs(): number {
  const configured = Number(process.env.MOCODE_CONNECT_TIMEOUT_MS ?? process.env.MOCODE_ATTEMPT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 20_000;
}

/**
 * Silence budget while reading the stream.
 *
 * Reset on **every chunk**. A provider that keeps emitting bytes is healthy no
 * matter how long the whole turn takes; only a provider that goes quiet is a
 * stall. This is the primitive Claude Code / Codex-style clients use, and it is
 * why a long code generation never trips a timeout.
 */
export function stallTimeoutMs(): number {
  const configured = Number(process.env.MOCODE_STALL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 120_000;
}

/**
 * How many chunks to inspect before declaring the stream healthy.
 *
 * The server answers `200` and puts the upstream failure *inside* the SSE body, so
 * `response.ok` says nothing about whether the provider worked. Peeking is the only
 * way to fail over without changing the server's streaming contract.
 */
const PEEK_MAX_CHUNKS = 16;

/**
 * Events that prove the provider produced something.
 *
 * Deliberately excludes `text-start` / `tool-input-start`: those arrive *before*
 * any content, so treating them as success would suppress failover for a provider
 * that opens a block and then fails.
 */
const HEALTHY_EVENT_TYPES = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-input-available",
  "tool-call",
  "finish",
  "finish-step",
]);

type StreamInspection = { error: string | null; response: Response };

/** Extract `data: {...}` payloads from a partial SSE buffer. */
function completeDataLines(buffer: string): string[] {
  return buffer
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");
}

/**
 * Read just enough of the SSE body to tell "the provider worked" from
 * "the provider rejected us", then hand back an equivalent response.
 *
 * Buffered bytes are replayed into the returned stream, so nothing is lost.
 */
type InspectionOptions = {
  /** Silence budget; reset on every chunk. */
  stallMs: number;
  /** Cancels the underlying response when the stall budget is exceeded. */
  abort: () => void;
};

async function inspectStream(
  response: Response,
  inspection: InspectionOptions,
): Promise<StreamInspection> {
  if (!response.body) return { error: null, response };

  const reader = response.body.getReader();
  let stallTimer = setTimeout(inspection.abort, inspection.stallMs);
  const resetStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(inspection.abort, inspection.stallMs);
  };
  const buffered: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let text = "";
  let finished = false;
  let sawOutput = false;

  try {
  for (let read = 0; read < PEEK_MAX_CHUNKS; read += 1) {
    const { done, value } = await reader.read();
    // Any bytes at all mean the provider is alive, however slow the turn is.
    resetStall();
    if (done) {
      finished = true;
      break;
    }

    buffered.push(value);
    text += decoder.decode(value, { stream: true });

    for (const payload of completeDataLines(text)) {
      let parsed: { type?: unknown; errorText?: unknown; error?: unknown };
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }

      if (parsed.type === "error") {
        await reader.cancel().catch(() => {});
        const detail =
          typeof parsed.errorText === "string"
            ? parsed.errorText
            : typeof parsed.error === "string"
              ? parsed.error
              : "upstream provider error";
        return { error: detail, response };
      }

      if (typeof parsed.type === "string" && HEALTHY_EVENT_TYPES.has(parsed.type)) {
        sawOutput = true;
        read = PEEK_MAX_CHUNKS; // healthy — stop peeking
        break;
      }
    }

    // Only the newest line can be incomplete; drop it before re-checking next round.
    text = text.slice(text.lastIndexOf("\n") + 1);
  }

  } finally {
    clearTimeout(stallTimer);
  }

  // EOF before any real output is not success — but only for SSE bodies. A plain
  // JSON/text response is not a stream and must pass through untouched.
  const isSse = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  if (finished && isSse && !sawOutput) {
    return { error: "stream ended before any output", response };
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);

      if (finished) {
        controller.close();
        return;
      }

      void (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              return;
            }
            controller.enqueue(value);
          }
        } catch (cause) {
          controller.error(cause);
        }
      })();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return {
    error: null,
    response: new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
  };
}

/** Combine the caller's abort signal with our own cancellable deadline. */
function attemptSignal(
  userSignal: AbortSignal | null | undefined,
  deadline: AbortSignal,
): AbortSignal {
  return userSignal ? AbortSignal.any([userSignal, deadline]) : deadline;
}

/** Error shape `classifyFailover` treats as a retryable timeout. */
function timeoutError(): Error {
  const error = new Error("attempt timed out before the stream started");
  error.name = "TimeoutError";
  return error;
}

/**
 * Wrap `fetch` so a retryable failure transparently retries on the next model.
 *
 * Bodies that are not a JSON object with a `model` field pass straight through —
 * this wrapper only knows how to fail over chat requests.
 */
export function createFailoverFetch(
  options: FailoverFetchOptions,
): typeof globalThis.fetch {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const connectMs = options.connectTimeoutMs ?? options.attemptTimeoutMs ?? connectTimeoutMs();
  const stallMs = options.stallTimeoutMs ?? stallTimeoutMs();

  return (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => {
    const body = typeof init?.body === "string" ? init.body : null;
    if (!body) return fetchImpl(input, init);

    let payload: { model?: unknown };
    try {
      payload = JSON.parse(body) as { model?: unknown };
    } catch {
      return fetchImpl(input, init);
    }

    const primary = typeof payload.model === "string" ? payload.model : null;
    if (!primary) return fetchImpl(input, init);

    const outcome = await runWithFailover({
      primary,
      fallbacks: options.fallbacks,
      consent: options.allowFailover === true,
      attemptsPerModel: options.attemptsPerModel,
      sleep: options.sleep,
      attempt: async (modelId) => {
        const attemptBody =
          modelId === primary ? body : JSON.stringify({ ...payload, model: modelId });

        // Phase 1: connect + headers. Bounded, because a dead endpoint should fail
        // fast instead of hanging the turn.
        const controller = new AbortController();
        const connectDeadline = setTimeout(() => controller.abort(), connectMs);

        try {
          const response = await fetchImpl(input, {
            ...init,
            body: attemptBody,
            signal: attemptSignal(init?.signal, controller.signal),
          });

          // Headers arrived: the network is fine. From here on only *silence* is a
          // failure, and `inspectStream` resets its timer on every chunk.
          clearTimeout(connectDeadline);

          if (!response.ok) {
            throw new HttpError(response.status, await options.readError(response));
          }

          // 200 does not mean the provider worked: the server streams upstream
          // failures as an `error` event inside the body. Fail over on those too.
          const inspected = await inspectStream(response, {
            stallMs,
            abort: () => controller.abort(),
          });
          if (inspected.error) {
            throw new HttpError(502, inspected.error);
          }

          return inspected.response;
        } catch (error) {
          // Our deadline must be retryable; a user abort must never be retried —
          // even when the underlying throw looks like a retryable HttpError.
          if (init?.signal?.aborted) {
            const abort = new Error("The operation was aborted");
            abort.name = "AbortError";
            throw abort;
          }
          if (controller.signal.aborted) throw timeoutError();
          throw error;
        } finally {
          clearTimeout(connectDeadline);
        }
      },
      onAttemptFailed: options.onAttemptFailed,
    });

    if (outcome.downgradedFrom) {
      options.onDowngrade?.({
        from: outcome.downgradedFrom,
        to: outcome.modelId,
        failures: outcome.failures,
      });
    }

    return outcome.value;
  }) as typeof globalThis.fetch;
}
