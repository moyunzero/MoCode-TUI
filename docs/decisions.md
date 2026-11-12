# Decisions — the numbers that look arbitrary

Every constant in this repo that a reader could reasonably call "made up" gets an
entry: the value, where it came from, and the condition that should make you change
it. Anything without a source is marked as a judgment call — pretending otherwise
is how a codebase accumulates cargo cult.

Sources below were read from first-party code, not blog posts.

## Turn budget

| Product | Limit | First-party source |
|---|---|---|
| Claude Agent SDK | **unbounded** — `max_turns: int \| None = None` | `anthropics/claude-agent-sdk-python`, `src/claude_agent_sdk/types.py` |
| LangGraph 1.2.4 | **10007** — `DEFAULT_RECURSION_LIMIT`, env `LANGGRAPH_DEFAULT_RECURSION_LIMIT` | `langgraph/_internal/_config.py:31` |
| OpenAI Agents SDK | **10** — `DEFAULT_MAX_TURNS` | `openai/openai-agents-python`, `src/agents/run_config.py:45` |
| **MoCode, main loop** | **50** continuations = 51 responses | `agent-loop.ts` |
| **MoCode, subagent** | **25** steps | `subagent/runner.ts` |

**Why 50.** The previous value was 24, copied from the subagent cap. That cap is
itself legacy: the widely repeated "LangGraph defaults to 25" is obsolete —
1.2.4 ships 10007, raised because 25 interrupted legitimate long tasks. The
published range today is 10 (OpenAI) to unbounded (Anthropic). A coding agent sits
near the long end, but "unbounded" turns a bug into an unbounded bill, so this stays
a budget. Measured on 20 eval tasks: max 13 turns, so 50 is ~4x headroom.

Override: `MOCODE_MAX_TURNS`.

**Why the subagent stays 25.** It runs synchronously — the parent blocks until it
returns a summary, so a generous budget spends the parent's wall clock. The tight
cap is the feature. (This is a better reason than "keep the two numbers equal",
which is what the previous comment said.)

## Tool calls per turn: 16

No published equivalent. OpenAI's `ToolExecutionConfig.max_function_tool_concurrency`
bounds *concurrency*, not the number of calls in one turn.

This is a **circuit breaker, not a budget**: measured turns use a mean of 1.26 tools
and a max of 2.33. 16 is roughly 7x the observed max — high enough that batch work
("change the imports in these 12 files") never trips it, low enough that a
pathological 50-way fan-out does.

Override: `MOCODE_MAX_TOOL_CALLS`.

## Consecutive identical calls: 3

The 4th consecutive call with the same tool and same input stops the run with
`no-progress`.

**"Consecutive" is the whole design**: `read -> edit -> read` resets the counter,
so normal edit loops are not false positives. 3 is a judgment call — a legitimate
retry rarely repeats an identical call more than twice.

Override: `MOCODE_MAX_REPEATS`.

## Context compaction: 60k tokens, keep 10 messages, min 16

Anthropic and OpenAI both publish guidance to compact as a conversation approaches
the model's window. **This is not that.** `deepseek-flash` accepts 1M tokens, so the
60k budget is a **cost** ceiling, not a window limit.

Measured on a 50-turn synthetic session (one tool call per turn, 10k-char output —
the `readFile` truncation limit): 139,010 -> 14,011 tokens, flat after turn ~24.

`minMessages: 16` exists so a short conversation is never compacted: early turns are
mostly intent, and folding them destroys the task.

## Provider retries: 3 attempts, 500ms base, 8s cap

- Retried on the same provider: 408 / 429 / 5xx / timeouts / connection errors.
- **Not** retried on the same provider: 401 / 403 / 404 — they answer identically in
  500ms, so a retry only delays the fallback.
- Delay is exponential (500ms, 1s, 2s, …) plus up to 500ms of jitter, so parallel
  retries do not synchronise on the provider.

Override: `MOCODE_PROVIDER_RETRIES`.

## Timeouts: connect 20s, stall 120s

Two different questions, deliberately separate:

- **connect** bounds DNS + TCP + TLS + response headers, and is cleared the moment
  headers arrive. It never bounds generation.
- **stall** bounds *silence*: it resets on every chunk. A five-minute stream that
  keeps emitting bytes is healthy and must not be killed.

Getting this wrong is what produced the "The operation timed out" mid-reply bug.

Overrides: `MOCODE_CONNECT_TIMEOUT_MS`, `MOCODE_STALL_TIMEOUT_MS`.

## Audit rotation: 5MB × 5 archives

Bounded disk: at most ~30MB. Size-triggered rather than time-triggered because a CLI
process may live for minutes or a day, and clock-based cutoffs either lose the burst
or create dozens of empty files.

## Not verified

CrewAI's `max_iter` default could not be located in first-party source (its repo moved
to a `lib/crewai-core` layout and the module path guesses failed), so it is **not**
used as evidence for any value here. If you need it, check
`lib/crewai-core/src/crewai/` directly.
