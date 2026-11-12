/**
 * Model failover — retry a turn on the next model when the current provider fails.
 *
 * Why: `resolveChatModel` hard-binds one provider per model. On a network where that
 * provider is region-blocked, 13 of 15 catalog models were unusable (see
 * `packages/server/scripts/provider-failover-bench.ts`). A single unreachable
 * provider meant 100% of turns failed with a bare `Forbidden`.
 *
 * This module is pure orchestration — no I/O, no React. Callers supply an `attempt`
 * thunk; the module decides whether a failure is worth retrying, walks the chain,
 * and reports which model actually answered so the downgrade can be shown to the user.
 *
 * A downgrade is never silent: `downgradedFrom` is non-null whenever a fallback
 * answered, and callers must surface it.
 */
import type { SupportedChatModelId } from "@mocode/shared";

/**
 * Ordered fallback chain.
 *
 * `deepseek-v4-pro` is deliberately NOT here: it costs roughly four times
 * `deepseek-flash`, and silently escalating a user's spend because the cheap model
 * was rate-limited is not a decision this code gets to make. Opt in explicitly via
 * `MOCODE_FALLBACK_CHAIN` when the extra cost is acceptable.
 */
export const DEFAULT_FALLBACK_CHAIN: readonly SupportedChatModelId[] = ["deepseek-flash"];

/**
 * Whether the operator has authorised cross-provider failover.
 *
 * Off unless explicitly enabled: retrying on another vendor sends the same code to
 * a different company, which needs a decision, not a default.
 */
export function failoverConsentFromEnv(): boolean {
  return process.env.MOCODE_ALLOW_MODEL_FAILOVER === "1";
}

/** Fallback chain, overridable by the operator. */
export function fallbackChainFromEnv(): readonly string[] {
  const configured = process.env.MOCODE_FALLBACK_CHAIN?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return configured && configured.length > 0 ? configured : DEFAULT_FALLBACK_CHAIN;
}

/** HTTP statuses that mean "this provider cannot serve us — try another". */
const RETRYABLE_STATUS = new Set([401, 403, 404, 408, 429, 500, 502, 503, 504]);

/** Subset that is worth retrying against the *same* provider. */
const SAME_PROVIDER_RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type FailoverDecision = {
  /** Worth trying *somewhere* — another provider or a later attempt. */
  retryable: boolean;
  /**
   * Worth retrying against the **same** provider.
   *
   * A 403/401/404 will answer identically in 500ms; retrying it only delays the
   * fallback and burns the user's patience. 429/5xx/timeouts are transient and do
   * deserve a backed-off retry.
   */
  retrySameProvider: boolean;
  /** Short machine-readable bucket, used in logs and tests. */
  kind: "http" | "timeout" | "abort" | "network" | "unknown";
  detail: string;
};

/**
 * Build the attempt order for a primary model: primary first, then the fallbacks,
 * de-duplicated. A fallback equal to the primary is dropped rather than retried
 * against the same broken provider.
 */
export function buildModelChain(
  primary: string,
  fallbacks: readonly string[] = DEFAULT_FALLBACK_CHAIN,
): string[] {
  const seen = new Set<string>();
  const chain: string[] = [];

  for (const id of [primary, ...fallbacks]) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    chain.push(id);
  }

  return chain;
}

/** Read a numeric HTTP status off an SDK/`fetch` error, if there is one. */
function statusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null) return null;

  const candidate = error as {
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };

  for (const value of [candidate.statusCode, candidate.status, candidate.response?.status]) {
    if (typeof value === "number") return value;
  }

  return null;
}

/**
 * Decide whether a failed attempt is worth retrying on another model.
 *
 * Deliberately conservative: a 400 means *we* built a bad request, and a user abort
 * (Esc) must never be retried — retrying either would mask the real problem.
 */
export function classifyFailover(error: unknown): FailoverDecision {
  const status = statusOf(error);
  if (status !== null) {
    return {
      retryable: RETRYABLE_STATUS.has(status),
      // Auth/URL rejections are not transient; rate limits and server faults are.
      retrySameProvider: SAME_PROVIDER_RETRY_STATUS.has(status),
      kind: "http",
      detail: `HTTP ${status}`,
    };
  }

  const name = error instanceof Error ? error.name : "";

  if (name === "AbortError") {
    return { retryable: false, retrySameProvider: false, kind: "abort", detail: "aborted by caller" };
  }

  if (name === "TimeoutError") {
    return { retryable: true, retrySameProvider: true, kind: "timeout", detail: "attempt timed out" };
  }

  const message = error instanceof Error ? error.message : String(error);

  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|network/i.test(message)) {
    return { retryable: true, retrySameProvider: true, kind: "network", detail: message.slice(0, 80) };
  }

  return { retryable: false, retrySameProvider: false, kind: "unknown", detail: message.slice(0, 80) };
}

/** What the caller must surface: which model answered, and what it replaced. */
export type FailoverOutcome<T> = {
  value: T;
  /** Model that actually produced the result. */
  modelId: string;
  /** Non-null when a fallback answered — the UI must show this. */
  downgradedFrom: string | null;
  /** Failures that happened before the successful attempt. */
  failures: Array<{ modelId: string; detail: string }>;
};

/** Attempts per model before giving up on it. Retries are what make a valid key
 * sufficient: a transient 429 or stalled connection should not end the turn. */
export function attemptsPerModelFromEnv(): number {
  const configured = Number(process.env.MOCODE_PROVIDER_RETRIES);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 3;
}

/** Exponential backoff with jitter: 500ms, 1s, 2s … capped at 8s. */
export function retryDelayMs(attempt: number, baseMs = 500): number {
  const exponential = Math.min(baseMs * 2 ** (attempt - 1), 8_000);
  return exponential + Math.floor(Math.random() * baseMs);
}

export type FailoverOptions<T> = {
  primary: string;
  fallbacks?: readonly string[];
  /** Attempts per model. Defaults to `MOCODE_PROVIDER_RETRIES` or 3. */
  attemptsPerModel?: number;
  /** Base backoff delay. */
  retryBaseMs?: number;
  /** Injectable for tests so they do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Explicit authorisation to send the turn to a *different* provider.
   *
   * Required, with no default: switching provider means the user's code leaves for
   * a vendor they did not pick. Without consent only the selected model is tried
   * and its failure surfaces unchanged.
   */
  consent: boolean;
  /** One attempt against one model. Throw to signal failure. */
  attempt: (modelId: string) => Promise<T>;
  /** Called for every failure so callers can log it. */
  onAttemptFailed?: (event: { modelId: string; decision: FailoverDecision }) => void;
};

/**
 * Run `attempt` down the chain until one succeeds.
 *
 * Re-throws the *last* error when every candidate fails, so the original cause is
 * not swallowed. Non-retryable failures (bad request, user abort) throw immediately
 * without burning fallbacks.
 */
export async function runWithFailover<T>({
  primary,
  fallbacks = fallbackChainFromEnv(),
  consent,
  attemptsPerModel = attemptsPerModelFromEnv(),
  retryBaseMs = 500,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempt,
  onAttemptFailed,
}: FailoverOptions<T>): Promise<FailoverOutcome<T>> {
  if (!consent) {
    // No authorisation to switch providers — but retrying the *selected* provider
    // is not a privacy decision, and a transient failure must not end the turn.
    const value = await attemptWithRetries(primary, attempt, {
      attemptsPerModel,
      retryBaseMs,
      sleep,
      onAttemptFailed,
    });
    return { value, modelId: primary, downgradedFrom: null, failures: [] };
  }

  const chain = buildModelChain(primary, fallbacks);
  const failures: FailoverOutcome<T>["failures"] = [];
  let lastError: unknown;

  for (const modelId of chain) {
    try {
      const value = await attemptWithRetries(modelId, attempt, {
        attemptsPerModel,
        retryBaseMs,
        sleep,
        onAttemptFailed,
      });

      return {
        value,
        modelId,
        downgradedFrom: modelId === primary ? null : primary,
        failures,
      };
    } catch (error) {
      const decision = classifyFailover(error);
      failures.push({ modelId, detail: decision.detail });
      if (!decision.retryable) throw error;
      lastError = error;
    }
  }

  throw lastError ?? new Error("No model candidates available");
}

type RetryContext = {
  attemptsPerModel: number;
  retryBaseMs: number;
  sleep: (ms: number) => Promise<void>;
  onAttemptFailed?: FailoverOptions<unknown>["onAttemptFailed"];
};

/** One model, up to `attemptsPerModel` tries with backoff. Non-retryable throws at once. */
async function attemptWithRetries<T>(
  modelId: string,
  attempt: (modelId: string) => Promise<T>,
  context: RetryContext,
): Promise<T> {
  let lastError: unknown;

  for (let attemptNo = 1; attemptNo <= context.attemptsPerModel; attemptNo += 1) {
    try {
      return await attempt(modelId);
    } catch (error) {
      const decision = classifyFailover(error);
      context.onAttemptFailed?.({ modelId, decision });

      if (!decision.retryable) throw error;
      lastError = error;

      // A rejection that will repeat verbatim is not worth waiting for.
      if (!decision.retrySameProvider) throw error;

      if (attemptNo < context.attemptsPerModel) {
        await context.sleep(retryDelayMs(attemptNo, context.retryBaseMs));
      }
    }
  }

  throw lastError ?? new Error(`All ${context.attemptsPerModel} attempts failed for ${modelId}`);
}
