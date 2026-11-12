/**
 * Context-compaction bench.
 *
 * Measures what bounds the prompt actually buys on a long session. No API calls —
 * the conversation is synthetic but sized like real agent traffic (tool outputs
 * dominate, which is the whole reason compaction matters).
 *
 * Run from the repo root:
 *   bun run packages/server/scripts/context-compaction-bench.ts
 */
import {
  DEFAULT_COMPACTION_POLICY,
  compactMessages,
  estimateMessagesTokens,
} from "@mocode/shared";

type Msg = { id: string; role: string; parts: unknown[] };

/** One user turn plus the agent's tool round-trip, sized like real traffic. */
function turn(index: number): Msg[] {
  return [
    {
      id: `u${index}`,
      role: "user",
      parts: [{ type: "text", text: `检查 src/module-${index}.ts 的实现并说明问题。`.repeat(6) }],
    },
    {
      id: `a${index}`,
      role: "assistant",
      parts: [
        { type: index % 2 === 0 ? "tool-readFile" : "tool-bash", input: { path: `src/module-${index}.ts` }, output: "x".repeat(10_000) },
        { type: "text", text: `模块 ${index} 的问题是边界条件缺失。`.repeat(12) },
      ],
    },
  ];
}

function session(turns: number): Msg[] {
  return Array.from({ length: turns }, (_, index) => turn(index)).flat();
}

const TURNS = 50;
const messages = session(TURNS);

console.log(`=== ${TURNS} 轮会话（每轮 1 次工具调用 + 10k 字符输出（= readFile 截断上限））===\n`);
console.log("turn".padEnd(8), "无压缩 prompt tokens".padEnd(24), "有压缩");
console.log("-".repeat(60));

for (let turns = 5; turns <= TURNS; turns += 5) {
  const slice = messages.slice(0, turns * 2);
  const before = estimateMessagesTokens(slice);
  const compacted = compactMessages(slice, DEFAULT_COMPACTION_POLICY);
  const after = compacted.compacted ? compacted.tokensAfter : before;
  const saved = before === 0 ? 0 : Math.round(((before - after) / before) * 100);

  console.log(
    String(turns).padEnd(8),
    String(before).padEnd(24),
    `${after}${compacted.compacted ? `  (-${saved}%)` : ""}`,
  );
}

const before = estimateMessagesTokens(messages);
const result = compactMessages(messages, DEFAULT_COMPACTION_POLICY);
const reduction = Math.round(((before - result.tokensAfter) / before) * 100);

console.log("\n=== 结论（完整 50 轮） ===");
console.log("压缩触发:", result.compacted ? "是" : "否");
console.log("prompt tokens:", before, "→", result.tokensAfter, `(-${reduction}%)`);
console.log("消息条数:", messages.length, "→", result.messages.length);
console.log("策略:", JSON.stringify(DEFAULT_COMPACTION_POLICY));

if (result.digest) {
  console.log("\n=== 折叠出的摘要（进上下文的就是这一段） ===");
  console.log(result.digest.slice(0, 400));
}
