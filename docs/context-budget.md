# Context budget & compaction

The server replays the stored session on every turn, so the prompt grows linearly
with session length. Left alone, a long session either overflows the model window
or pays for history nobody re-reads.

Compaction puts a **ceiling** on that growth: past the budget, old turns collapse
into one digest message.

## Policy

```ts
{ maxTokens: 60_000, keepRecent: 10, minMessages: 16 }
```

- `maxTokens` is a **cost** budget, not a context-window budget. DeepSeek Flash
  accepts 1M tokens; 60k is where continued growth stops being worth paying for.
- Below `minMessages` compaction is skipped — a short conversation is mostly
  intent, and folding it would destroy the task.

## What the digest contains

```
[compacted] 90 earlier messages folded away (45 user turns).
Tools already used: readFile×23, bash×22.
Files touched: src/module-0.ts, src/module-1.ts, …
Those turns are no longer in context; re-read a file if you need its exact contents.
```

It is **deterministic, not an LLM summary**. That is a deliberate trade:

| | deterministic digest | LLM summary |
|---|---|---|
| cost | 0 | one extra model call per compaction |
| latency | 0 | +1 round trip |
| failure mode | none | the summarizer can itself fail or hallucinate |
| fidelity | what tools ran, which files were touched | prose semantics |

What the agent actually needs from old turns is *what it already did* — tool names,
file paths — not the prose around it. The last line matters more than it looks: it
tells the model the content is **gone**, so it re-reads instead of inventing.

## Measured

```bash
bun run packages/server/scripts/context-compaction-bench.ts
```

Synthetic but realistically sized: one tool call per turn, 10k-char output (the
`readFile` truncation limit).

| turns | prompt tokens (no compaction) | with compaction |
|---|---|---|
| 20 | 55,580 | 55,580 (not yet triggered) |
| 25 | 69,485 | 14,011 (−80%) |
| 50 | **139,010** | **14,011 (−90%)** |

The number that matters is not the −90% at turn 50, it is that the prompt is
**flat** after turn ~24. Without it, cost per turn grows linearly forever.

## Design rules

1. **The cut lands on a user message.** Splitting a tool call from its result would
   produce an invalid conversation, so `findCutIndex` snaps forward to the next
   `user` role.
2. **Compaction shapes model input only.** The persisted message list and the
   messages echoed back to the client stay complete — otherwise the user's own
   transcript would lose history.
3. **It is bounded.** Running compaction twice does not compound; a covered test
   asserts the second pass never increases tokens.
4. **It is observable.** When a turn is compacted, the finish metadata carries
   `compaction: { tokensBefore, tokensAfter }`.

## Manual acceptance

1. Start a session, let it run past ~25 tool calls with large files.
2. The finish metadata of that turn should carry `compaction` (visible in the SSE
   frame or server logs).
3. Continue the session — the prompt estimate stays flat instead of climbing.
4. Ask the agent about something from the compacted range. Expected: it re-reads
   the file rather than fabricating details. That is the digest working.

## Follow-ups

- ~~BYOK has no compaction~~ — done: the module moved to `@mocode/shared` and both
  the server route and `LocalChatTransport` apply the same policy.
- **Tool-output truncation is still flat** (10k/20k chars per tool). Per-tool,
  budget-aware limits would squeeze more out of a turn.
- **No eviction of stale file reads.** Re-reading the same file repeatedly still
  costs full tokens each time.
