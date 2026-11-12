/**
 * Manual acceptance runner.
 *
 * One command that exercises the four shipped capabilities the way a user would
 * hit them, and prints PASS/FAIL per check. It replaces "trust me, the tests
 * pass" with something you can actually watch.
 *
 * What it CANNOT cover: colours, toasts, and transcript behaviour in the TUI.
 * Those need a real terminal — see `--` section at the bottom of the output.
 *
 *   bun run packages/cli/scripts/acceptance.ts
 *   bun run packages/cli/scripts/acceptance.ts --with-eval     # also runs 2 real tasks
 *   bun run packages/cli/scripts/acceptance.ts --with-network  # also probes real providers
 */
import { readFileSync, rmSync } from "node:fs";
import { isShellConfined, sandboxCapability } from "../src/lib/sandbox-capability";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Mode } from "@mocode/shared";
import { executeLocalTool } from "../src/lib/local-tools";
import { createFailoverFetch } from "../src/lib/chat-fetch";
import { buildModelChain, classifyFailover, runWithFailover } from "../src/lib/provider-chain";

const args = new Set(process.argv.slice(2));
const withEval = args.has("--with-eval");
const withNetwork = args.has("--with-network");

type Check = { section: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function record(section: string, name: string, ok: boolean, detail: string) {
  checks.push({ section, name, ok, detail });
  console.log(`  ${ok ? "✅" : "❌"} ${name}`);
  if (detail) console.log(`     ${detail}`);
}

/** Expect the call to reject; report the message for eyeballing. */
async function expectRefusal(
  section: string,
  name: string,
  run: () => Promise<unknown>,
  needle: string,
) {
  try {
    await run();
    record(section, name, false, "NOT REFUSED — this is a real hole");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    record(section, name, message.includes(needle), message.slice(0, 90));
  }
}

function sh(command: string[]): { code: number; out: string } {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return {
    code: result.exitCode ?? 1,
    out: `${result.stdout.toString()}${result.stderr.toString()}`.trim(),
  };
}

// ---------------------------------------------------------------------------
console.log("\n=== P1 · Provider 失败回退 ===\n");

{
  // Policy invariants — the part that must never regress, regardless of network.
  const chain = buildModelChain("gpt-oss-120b");
  record(
    "P1",
    "回退链把主模型排在首位、且不重复尝试同一家",
    chain[0] === "gpt-oss-120b" && new Set(chain).size === chain.length,
    chain.join(" → "),
  );

  const blocked = classifyFailover(Object.assign(new Error("x"), { statusCode: 403 }));
  record("P1", "403 判定为可重试（换一家可能就好了）", blocked.retryable, blocked.detail);

  const badRequest = classifyFailover(Object.assign(new Error("x"), { statusCode: 400 }));
  record(
    "P1",
    "400 判定为不可重试（是我们请求体写错了）",
    badRequest.retryable === false,
    badRequest.detail,
  );

  const aborted = classifyFailover(Object.assign(new Error("x"), { name: "AbortError" }));
  record("P1", "用户按 Esc 取消后不重试", aborted.retryable === false, aborted.detail);

  // Real orchestration with a simulated provider (no network, no cost).
  const outcome = await runWithFailover({
    primary: "gpt-oss-120b",
    consent: true,
    attempt: async (modelId) => {
      if (modelId === "gpt-oss-120b") throw Object.assign(new Error("blocked"), { statusCode: 403 });
      return `answered by ${modelId}`;
    },
  });
  record(
    "P1",
    "降级被显式上报（downgradedFrom 非空）",
    outcome.downgradedFrom === "gpt-oss-120b" && outcome.modelId === "deepseek-flash",
    `${outcome.downgradedFrom} → ${outcome.modelId}`,
  );
}

{
  // The shape that broke in production: server answers 200, the provider error
  // arrives as an SSE event. Status-code-only retry logic never fires here.
  const sse = (events: Array<Record<string, unknown>>) =>
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  let calls = 0;
  const fetchWithFallback = createFailoverFetch({
    allowFailover: true,
    fetchImpl: (async () => {
      calls += 1;
      return calls === 1
        ? sse([{ type: "start" }, { type: "error", errorText: "Forbidden" }])
        : sse([{ type: "start" }, { type: "text-delta", delta: "ok" }, { type: "finish" }]);
    }) as unknown as typeof globalThis.fetch,
    readError: async (response) => `HTTP ${response.status}`,
  });

  const response = await fetchWithFallback("http://localhost:3000/chat", {
    method: "POST",
    body: JSON.stringify({ id: "s", model: "gpt-oss-120b", mode: "build", messages: [] }),
  });
  const text = await response.text();

  record(
    "P1",
    "200 响应体里的 error 事件也会触发回退",
    calls === 2 && text.includes("ok"),
    `共 ${calls} 次请求，最终流内容包含成功响应`,
  );
}

if (withNetwork) {  console.log("\n  [--with-network] 真实探测三家 Provider（约 40 秒）…");
  const result = sh(["bun", "run", "packages/server/scripts/provider-failover-bench.ts"]);
  const e2e = result.out.split("端到端回退")[1] ?? "";
  record(
    "P1",
    "真实请求下回退到 DeepSeek 并成功",
    e2e.includes("deepseek-flash") && e2e.includes("(downgraded)"),
    "见下方 provider-failover-bench 输出",
  );
  console.log(result.out.split("\n").slice(-12).join("\n"));
} else {
  console.log("\n  （网络真实探测需加 --with-network）");
}

// ---------------------------------------------------------------------------
console.log("\n=== P2 · 权限与沙箱 ===\n");

{
  // Informational: which sandbox backend this host can actually apply.
  const capability = sandboxCapability();
  const verdict = capability.available
    ? `✅ 可用（${capability.backend}，${capability.enforced ? "已在 spawn 处套用" : "未套用"}）`
    : `⚠️  不可用（${capability.backend}）→ 每条 bash 命令都需人工批准`;

  console.log(`  ${verdict}`);
  console.log(`     ${capability.detail}`);
}

await expectRefusal(
  "P2",
  "读 /etc/passwd 被拒",
  () => executeLocalTool("readFile", { path: "/etc/passwd" }, Mode.BUILD),
  "outside the project",
);

await expectRefusal(
  "P2",
  "父目录穿越 ../../etc/passwd 被拒",
  () => executeLocalTool("readFile", { path: "../../../../etc/passwd" }, Mode.BUILD),
  "outside the project",
);

await expectRefusal(
  "P2",
  "写到项目外被拒",
  () => executeLocalTool("writeFile", { path: "/tmp/mocode-acceptance.txt", content: "x" }, Mode.BUILD),
  "outside the project",
);

await expectRefusal(
  "P2",
  "硬封禁命令（dd 写设备）即使批准也拒绝",
  () => executeLocalTool("bash", { command: "dd if=/dev/zero of=/dev/null count=1" }, Mode.BUILD),
  "cannot be approved",
);

await expectRefusal(
  "P2",
  "Plan 模式写文件被拒",
  () => executeLocalTool("writeFile", { path: "x.txt", content: "y" }, Mode.PLAN),
  "not available in PLAN",
);

{
  // Real leak probe: put a canary in the CLI process and ask the shell for it.
  const canary = "sk-acceptance-canary";
  const previousKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = canary;
  try {
    const result = (await executeLocalTool(
      "bash",
      { command: 'echo -n "${DEEPSEEK_API_KEY:-absent}"' },
      Mode.BUILD,
    )) as { stdout: string; stderr: string; exitCode: number };

    const clean = result.stdout === "absent" && !result.stdout.includes(canary);
    record(
      "P2",
      "子 shell 看不到 CLI 的密钥",
      clean,
      clean
        ? `echo $DEEPSEEK_API_KEY → "${result.stdout}"`
        : `stdout=${JSON.stringify(result.stdout)} exit=${result.exitCode} stderr=${JSON.stringify(
            (result.stderr ?? "").slice(0, 200),
          )} — 若 exit≠0 说明 shell 没跑起来，与密钥无关`,
    );
  } finally {
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousKey;
  }
}

{
  // Audit trail: a refusal that leaves no record is indistinguishable from a bug.
  const auditPath = join(tmpdir(), `mocode-acceptance-audit-${Date.now()}.jsonl`);
  process.env.MOCODE_AUDIT_PATH = auditPath;

  try {
    await expectRefusal(
      "P2",
      "越界读取在审计日志里留下 PATH_ESCAPE",
      () => executeLocalTool("readFile", { path: "/etc/shadow" }, Mode.BUILD),
      "outside the project",
    );

    const logged = readFileSync(auditPath, "utf8");
    record(
      "P2",
      "审计日志记录了拒绝原因",
      logged.includes('"code":"PATH_ESCAPE"') && logged.includes('"outcome":"denied"'),
      logged.trim().split("\n").at(-1)?.slice(0, 120) ?? "",
    );
  } catch {
    record("P2", "审计日志记录了拒绝原因", false, "日志文件未生成");
  } finally {
    delete process.env.MOCODE_AUDIT_PATH;
    try {
      rmSync(auditPath, { force: true });
    } catch {
      /* ignore */
    }
  }
}

{
  // The original exploit, replayed end-to-end: the agent read /etc/passwd through
  // bash and `head`, bypassing the file tools entirely.
  if (!isShellConfined()) {
    console.log("  ⏭  跳过「bash 读 /etc/passwd」：本机无 OS 沙箱，该路径靠审批阻挡");
  } else {
    const shellRead = (await executeLocalTool(
      "bash",
      { command: "head -1 /etc/passwd 2>&1" },
      Mode.BUILD,
    )) as { stdout: string; stderr: string; exitCode: number };

    const output = `${shellRead.stdout}${shellRead.stderr}`;
    const leaked = /^[^:\n]+:[^:\n]*:[0-9]+:/m.test(output);

    record(
      "P2",
      "bash 也读不到 /etc/passwd（原始逃逸路径已封）",
      !leaked,
      leaked ? `泄漏了内容：${output.slice(0, 80)}` : output.trim().slice(0, 90),
    );
  }
}

// ---------------------------------------------------------------------------
console.log("\n=== P3 · 上下文压缩 ===\n");

{
  const result = sh(["bun", "run", "packages/server/scripts/context-compaction-bench.ts"]);
  const triggered = result.out.includes("压缩触发: 是");
  const reduced = /→ (\d+) \(-(\d+)%\)/.exec(result.out);
  const percent = reduced?.[2] ?? "?";

  record(
    "P3",
    "50 轮会话触发压缩",
    triggered,
    result.out.split("\n").find((line) => line.startsWith("prompt tokens")) ?? "",
  );
  record("P3", "压缩后 prompt 显著下降（≥70%）", Number(percent) >= 70, `降幅 ${percent}%`);
  record(
    "P3",
    "折叠摘要说明了内容已不在上下文",
    result.out.includes("re-read a file"),
    "摘要末句提示模型需要时重新读文件",
  );
}

// ---------------------------------------------------------------------------
console.log("\n=== P4 · 任务评估 ===\n");

if (withEval) {
  console.log("  [--with-eval] 跑 2 条真实任务（约 15 秒，产生少量 token 费用）…");
  for (const id of ["fix-off-by-one", "rename-across-files"]) {
    const result = sh(["bun", "run", "packages/cli/evals/run.ts", "--only", id]);
    record("P4", `真实任务 ${id} 通过`, result.code === 0, result.out.split("\n")[2] ?? "");
  }
} else {
  const result = sh(["bun", "test", "packages/cli/evals/cases.test.ts"]);
  record(
    "P4",
    "元测试：每条用例在初始状态必须失败",
    result.code === 0,
    result.out.split("\n").find((line) => line.includes("pass")) ?? "",
  );
  console.log("  （真实任务需加 --with-eval）");
}

// ---------------------------------------------------------------------------
const failed = checks.filter((check) => !check.ok);

console.log("\n=== 汇总 ===");
console.log(`通过 ${checks.length - failed.length}/${checks.length}`);

if (failed.length > 0) {
  console.log("\n失败项：");
  for (const check of failed) console.log(`  - [${check.section}] ${check.name}: ${check.detail}`);
}

console.log(`
=== 需要你在真实终端里确认的部分（脚本无法覆盖）===

1) 状态行预算可视化
   bun run dev  →  发一条会连续调工具的任务
   期望：状态行出现 "turn 2/24 · 3 tools"，数字随工具调用递增

2) 降级提示（P1 的肉眼验证）
   /models 选 gpt-oss-120b  →  发消息
   期望：Toast「模型 gpt-oss-120b 不可用，已回退到 deepseek-flash」
         状态行出现红色 "fallback → deepseek-flash"
         回复内容正常，不是 Forbidden

3) 压缩可观测（P3）
   连续读几个大文件，跑过 25 轮
   期望：该轮 finish metadata 带 compaction 字段（服务端日志）

4) 任务评估全量
   bun run packages/cli/evals/run.ts
   期望：10/10，报告写入 packages/cli/evals/results/latest.json
`);

process.exit(failed.length === 0 ? 0 : 1);
