/**
 * Provider availability + failover bench.
 *
 * Why this exists: `resolveChatModel` hard-binds one provider per model. When that
 * provider is unreachable the whole agent turn dies with a bare `403 Forbidden`,
 * which is what actually happened on a mainland-China network.
 *
 * The fault source is real, not mocked: Cerebras / Groq / Anthropic answer 403
 * behind a country block, and the OpenAI / Google endpoints do not connect at all.
 * That makes them a free, reproducible fault injector — every failure below is a
 * genuine upstream failure, which is the whole point.
 *
 * It measures two policies against the same probe results:
 *   baseline — one model, one provider, no fallback
 *   failover — if the primary fails, walk FALLBACK_CHAIN
 *
 * Run it from the repo root so `.env` is picked up:
 *   bun run packages/server/scripts/provider-failover-bench.ts
 *
 * Note: this makes real API calls. The reachable providers cost a few tokens each.
 */
import { generateText, tool } from "ai";
import { z } from "zod";
import { SUPPORTED_CHAT_MODELS } from "@mocode/shared";
import { resolveChatModel } from "../src/lib/model";

/** Per-model budget. Must exceed normal latency but stay under user patience. */
const TIMEOUT_MS = 12_000;

/**
 * The failover policy under test. Ordered, cheapest-capable-first.
 * Today no such chain exists in the code — this script measures what adding it
 * would buy, using the probe results we already paid for (no extra requests).
 */
const FALLBACK_CHAIN = ["deepseek-flash", "deepseek-v4-pro"] as const;

/** Minimal tool so the probe also proves the provider can emit tool calls. */
const pingTool = tool({
  description: "List the entries of a directory.",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => ({ path, entries: ["a.ts"] }),
});

type Probe = {
  modelId: string;
  provider: string;
  ok: boolean;
  ms: number;
  detail: string;
};

/** Collapse SDK errors into something a table can show. */
function classify(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }

  const status = (error as { statusCode?: number }).statusCode;
  if (typeof status === "number") return `HTTP ${status}`;

  const message = error instanceof Error ? error.message : String(error);
  if (/is not set/.test(message)) return "no-key";
  return message.replace(/\s+/g, " ").slice(0, 58);
}

async function probe(modelId: string, provider: string): Promise<Probe> {
  const started = Date.now();

  try {
    const resolved = resolveChatModel(modelId);
    const result = await generateText({
      model: resolved.model,
      messages: [{ role: "user", content: "List the current directory using the ping tool." }],
      tools: { ping: pingTool },
      maxOutputTokens: 64,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // Answering without calling the tool is not a working agent turn — a model
    // that chats instead of acting would otherwise score as healthy.
    const calledPing = result.toolCalls.some((call) => call.toolName === "ping");

    return {
      modelId,
      provider,
      ok: calledPing,
      ms: Date.now() - started,
      detail: calledPing ? "tool_calls=1" : `no ping call (tool_calls=${result.toolCalls.length})`,
    };
  } catch (error) {
    return { modelId, provider, ok: false, ms: Date.now() - started, detail: classify(error) };
  }
}

function pct(part: number, total: number): string {
  return `${part}/${total} (${Math.round((part / total) * 100)}%)`;
}

const rows: Probe[] = [];

for (const model of SUPPORTED_CHAT_MODELS) {
  process.stdout.write(`  probing ${model.id} … `);
  const row = await probe(model.id, model.provider);
  rows.push(row);
  console.log(row.ok ? `ok ${(row.ms / 1000).toFixed(1)}s` : `FAIL ${row.detail}`);
}

const byId = new Map(rows.map((row) => [row.modelId, row]));

console.log("\n=== 逐模型探测（真实请求；失败即为上游真实故障） ===");
console.log("model".padEnd(30), "provider".padEnd(12), "result");
for (const row of rows) {
  const result = row.ok
    ? `ok  ${(row.ms / 1000).toFixed(1)}s  ${row.detail}`
    : `FAIL  ${(row.ms / 1000).toFixed(1)}s  ${row.detail}`;
  console.log(row.modelId.padEnd(30), row.provider.padEnd(12), result);
}

const baselineOk = rows.filter((row) => row.ok).length;
const failoverOk = rows.filter(
  (row) => row.ok || FALLBACK_CHAIN.some((id) => byId.get(id)?.ok),
).length;

console.log("\n=== 结论 ===");
console.log("无回退（单 provider 硬绑）:", pct(baselineOk, rows.length));
console.log("带回退（失败后走", FALLBACK_CHAIN.join(" → ") + "）:", pct(failoverOk, rows.length));

const failures = rows.filter((row) => !row.ok);
const fastFail = failures.filter((row) => row.ms < 5_000);
const slowFail = failures.filter((row) => row.ms >= 5_000);

console.log("\n=== 失败耗时分布（决定回退策略要不要设超时） ===");
console.log("快速失败 <5s（如 403）:", fastFail.length, "→", fastFail.map((r) => r.detail).join(", ") || "-");
console.log("慢失败 ≥5s（连接挂起）:", slowFail.length, "→", slowFail.map((r) => r.detail).join(", ") || "-");

if (slowFail.length > 0) {
  console.log(
    `\n注意：有 ${slowFail.length} 个模型是"挂到超时"才失败的。若回退链不设 per-attempt 超时，` +
      `一次请求会被最慢的那个 provider 拖到 ${TIMEOUT_MS / 1000}s 之后。`,
  );
}

// ---------------------------------------------------------------------------
// Phase 2 — end-to-end failover, real requests.
//
// Phase 1 above only *simulates* the policy by re-reading probe results. This
// phase actually walks the chain with real calls, so the wall-clock number
// includes the failed attempts a user would wait through.
//
// The policy below mirrors `packages/cli/src/lib/provider-chain.ts` (same
// retryable-status set). It is duplicated here on purpose: the server package may
// not import the CLI package, and a script must not be the thing that defines
// shipped behaviour.
// ---------------------------------------------------------------------------

const RETRYABLE = new Set([401, 403, 404, 408, 429, 500, 502, 503, 504]);

/** Three representative primaries: fast-fail, region-block, already-working. */
const E2E_SAMPLE = ["claude-sonnet-4-6", "gpt-oss-120b", "deepseek-flash"] as const;

function retryable(error: unknown): boolean {
  const status = (error as { statusCode?: number }).statusCode;
  if (typeof status === "number") return RETRYABLE.has(status);
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError") return false; // user cancel must never retry
  return name === "TimeoutError";
}

async function e2eFailover(primary: string) {
  const chain = [...new Set([primary, ...FALLBACK_CHAIN])];
  const started = Date.now();
  const failures: string[] = [];

  for (const modelId of chain) {
    try {
      const resolved = resolveChatModel(modelId);
      await generateText({
        model: resolved.model,
        messages: [{ role: "user", content: "List the current directory using the ping tool." }],
        tools: { ping: pingTool },
        maxOutputTokens: 64,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      });

      return {
        primary,
        answeredBy: modelId,
        downgraded: modelId !== primary,
        totalMs: Date.now() - started,
        failures,
      };
    } catch (error) {
      failures.push(`${modelId}: ${classify(error)}`);
      if (!retryable(error)) break;
    }
  }

  return {
    primary,
    answeredBy: null,
    downgraded: false,
    totalMs: Date.now() - started,
    failures,
  };
}

console.log("\n=== 端到端回退（真实请求，含失败的等待时间） ===");
for (const primary of E2E_SAMPLE) {
  const result = await e2eFailover(primary);
  const verdict = result.answeredBy
    ? `→ ${result.answeredBy}${result.downgraded ? " (downgraded)" : ""}  ${(result.totalMs / 1000).toFixed(1)}s`
    : `FAILED  ${(result.totalMs / 1000).toFixed(1)}s`;
  console.log(primary.padEnd(30), verdict);
  for (const failure of result.failures) console.log("".padEnd(30), `  ✗ ${failure}`);
}

