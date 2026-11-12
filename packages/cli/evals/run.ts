/**
 * Task eval runner.
 *
 * Runs each case against a real model with the real tool implementations, then
 * executes the case's check. This is the only measurement in the repo that scores
 * *end-to-end task success* rather than unit-level correctness.
 *
 * Run from the repo root (needs DEEPSEEK_API_KEY in `.env`):
 *   bun run packages/cli/evals/run.ts
 *   bun run packages/cli/evals/run.ts --only fix-off-by-one
 *
 * Each case gets a throwaway directory; the agent's cwd is switched into it, so
 * `executeLocalTool` resolves paths against the case and the sandbox still applies.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateText, stepCountIs, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { Mode, getToolContracts, toolInputSchemas } from "@mocode/shared";
import { executeLocalTool } from "../src/lib/local-tools";
import { EVAL_CASES, type EvalCase } from "./cases";
import { runCheck } from "./check-runner";

const MAX_TURNS = 15;

const SYSTEM = [
  "You are a coding agent working inside a small project directory.",
  "Use the available tools to read files, then edit them.",
  "Make the smallest change that satisfies the request.",
  "When the task is done, reply with a one-line summary and stop.",
].join(" ");

function buildModel() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not set — run from the repo root");

  return createOpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com/v1",
    name: "deepseek",
  }).chat("deepseek-flash");
}

/** Real tool implementations — same functions the CLI agent calls. */
function buildTools() {
  const contracts = getToolContracts(Mode.BUILD) as Record<string, { description?: string }>;

  return Object.fromEntries(
    Object.keys(contracts)
      // `task` spawns a subagent; out of scope for a single-turn eval.
      .filter((name) => name !== "task")
      .map((name) => [
        name,
        tool({
          description: contracts[name]?.description ?? name,
          inputSchema: toolInputSchemas[name as keyof typeof toolInputSchemas],
          execute: async (input: unknown) => executeLocalTool(name, input, Mode.BUILD),
        }),
      ]),
  );
}

function materialize(evalCase: EvalCase): string {
  const dir = mkdtempSync(join(tmpdir(), `mocode-eval-${evalCase.id}-`));

  for (const [path, content] of Object.entries(evalCase.files)) {
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  return dir;
}

type CaseResult = {
  id: string;
  category: EvalCase["category"];
  ok: boolean;
  turns: number;
  toolCalls: number;
  tokens: number;
  ms: number;
  checkExit: number | null;
  checkTail: string;
  summary: string;
};

async function runCase(evalCase: EvalCase, model: ReturnType<typeof buildModel>): Promise<CaseResult> {
  const dir = materialize(evalCase);
  const started = Date.now();

  let turns = 0;
  let toolCalls = 0;
  let tokens = 0;
  let summary = "";

  const originalCwd = process.cwd();

  try {
    process.chdir(dir);

    const result = await generateText({
      model,
      system: SYSTEM,
      prompt: evalCase.prompt,
      tools: buildTools(),
      stopWhen: stepCountIs(MAX_TURNS),
      maxOutputTokens: 1_500,
      onStepFinish(step) {
        turns += 1;
        toolCalls += step.toolCalls.length;
        tokens += step.usage?.totalTokens ?? 0;
      },
    });

    summary = result.text.trim().slice(0, 120);
  } catch (error) {
    summary = `agent error: ${error instanceof Error ? error.message.slice(0, 100) : "unknown"}`;
  } finally {
    process.chdir(originalCwd);
  }

  // Restore verifier files from the fixture before scoring: `verify.ts` (and any
  // protected test) is agent-writable, and a case that passes by rewriting its own
  // verifier measures nothing.
  const protectedFiles = new Set(evalCase.protectedFiles ?? ["verify.ts"]);
  for (const [path, content] of Object.entries(evalCase.files)) {
    if (!protectedFiles.has(path)) continue;
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }

  const check = await runCheck(dir, evalCase.check);
  const output = check.output;

  rmSync(dir, { recursive: true, force: true });

  return {
    id: evalCase.id,
    category: evalCase.category,
    ok: check.ok,
    turns,
    toolCalls,
    tokens,
    ms: Date.now() - started,
    checkExit: check.exitCode,
    checkTail: output.split("\n").slice(-2).join(" ").slice(0, 160),
    summary,
  };
}

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex === -1 ? null : process.argv[onlyIndex + 1];
const selected = only ? EVAL_CASES.filter((c) => c.id === only) : EVAL_CASES;

if (selected.length === 0) {
  console.error(`No eval case matched ${only ?? ""}`);
  process.exit(2);
}

const model = buildModel();
const results: CaseResult[] = [];

console.log(`Running ${selected.length} eval case(s), max ${MAX_TURNS} turns each\n`);
console.log("case".padEnd(24), "ok".padEnd(4), "turns".padEnd(7), "tools".padEnd(7), "tokens".padEnd(9), "time");

for (const evalCase of selected) {
  process.stdout.write(`${evalCase.id.padEnd(24)} `);
  const result = await runCase(evalCase, model);
  results.push(result);

  console.log(
    (result.ok ? "✅" : "❌").padEnd(4),
    String(result.turns).padEnd(7),
    String(result.toolCalls).padEnd(7),
    String(result.tokens).padEnd(9),
    `${(result.ms / 1000).toFixed(1)}s`,
  );

  if (!result.ok) console.log("".padEnd(25), `check exit ${result.checkExit}: ${result.checkTail}`);
}

const passed = results.filter((r) => r.ok).length;
const avg = (pick: (r: CaseResult) => number) =>
  results.length === 0 ? 0 : Math.round(results.reduce((sum, r) => sum + pick(r), 0) / results.length);

console.log("\n=== 汇总 ===");
console.log(`任务成功率: ${passed}/${results.length} (${Math.round((passed / results.length) * 100)}%)`);
console.log(`平均轮次: ${avg((r) => r.turns)}  平均工具数: ${avg((r) => r.toolCalls)}  平均 token: ${avg((r) => r.tokens)}`);

const byCategory = new Map<string, { ok: number; total: number }>();
for (const result of results) {
  const entry = byCategory.get(result.category) ?? { ok: 0, total: 0 };
  entry.total += 1;
  if (result.ok) entry.ok += 1;
  byCategory.set(result.category, entry);
}

console.log("\n=== 分类 ===");
for (const [category, entry] of byCategory) {
  console.log(`${category.padEnd(10)} ${entry.ok}/${entry.total}`);
}

const reportPath = new URL("./results/latest.json", import.meta.url);
mkdirSync(dirname(reportPath.pathname), { recursive: true });
writeFileSync(
  reportPath,
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      model: "deepseek-flash",
      maxTurns: MAX_TURNS,
      successRate: passed / results.length,
      totals: {
        cases: results.length,
        passed,
        avgTurns: avg((r) => r.turns),
        avgToolCalls: avg((r) => r.toolCalls),
        avgTokens: avg((r) => r.tokens),
      },
      results,
    },
    null,
    2,
  ),
);

console.log(`\n报告已写入 ${reportPath.pathname}`);
process.exit(passed === results.length ? 0 : 1);
