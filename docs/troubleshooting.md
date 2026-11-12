# Troubleshooting & incident log

Real failures hit while running MoCode locally, with the evidence that identified
them and what changed as a result. Append new entries at the bottom; keep the
symptom text exactly as the user sees it so search finds it.

## Reproducing the provider experiment

```bash
# from the repo root so .env is loaded
bun run packages/server/scripts/provider-failover-bench.ts
```

Every failure in that bench is a **real upstream failure** — no mocks. On a
mainland-China network the blocked providers are a free, reproducible fault
injector, which is why the numbers below are trustworthy.

---

## INC-001 — every message fails with `Forbidden`

**Symptom.** After `bun run dev`, sending any message in the TUI immediately fails
with `Forbidden`. Nothing in the transcript looks like a local error.

**Root cause.** Not MoCode. The default model was `gpt-oss-120b`, which is bound to
the **Cerebras** provider. Cerebras answers `403` with Cloudflare `error code 1009`
("banned your access based on your country"). MoCode's server passes upstream
errors through verbatim:

```ts
// packages/server/src/index.ts
app.onError((err, c) => {
    if (err instanceof HTTPException) {
        return c.json({ error: err.message || "Request failed" }, err.status);
    }
```

So the provider's `403`/`Forbidden` reaches the CLI unchanged.

**Evidence** (status codes only; keys never printed):

| provider | status | body |
|---|---|---|
| cerebras | 403 | `error code: 1009` |
| groq | 403 | `{"error":{"message":"Forbidden"}}` |
| anthropic | 403 | `{"type":"forbidden","message":"Request not allowed"}` |
| openai | — | connect timeout |
| google | — | connect timeout |
| openrouter | 401 | `User not found` |
| **deepseek** | **200** | reachable |

`grep -rn "403\|forbidden" packages/*/src` finds no `403` in MoCode itself — that
grep is the first thing to run, because it separates "our bug" from "upstream".

**Fix.** Default model switched to `deepseek-flash` (see INC-004).

**Lesson.** An error message that is a verbatim upstream string is a pass-through,
not a local failure. Check whether the string exists in the codebase before
debugging the codebase.

---

## INC-002 — DeepSeek model ids no longer exist

**Symptom.** After wiring DeepSeek, requests fail even though the key is valid.

**Root cause.** The catalog used the V3-era ids `deepseek-chat` and
`deepseek-reasoner`. The live `/models` endpoint returns only:

```
deepseek-flash     DeepSeek-V4.1-Flash   1M context, tool calls + vision
deepseek-v4-pro    DeepSeek-V4-Pro
```

**Fix.** Renamed in `packages/shared/src/models.ts`, pricing re-read from
`api-docs.deepseek.com/quick_start/pricing`, and both ids added to
`packages/server/scripts/test-providers.ts`.

**Pricing caveat.** DeepSeek bills four rates (cache hit/miss × peak/off-peak).
`ModelPricing` only has two fields, so entries use **peak cache-miss input + peak
output** — deliberately over- rather than under-charging. Modelling the four-rate
case is still open work.

**Lesson.** Model ids are not stable API surface. `test-providers.ts` exists to
catch exactly this; it only helps if it covers the provider you just added.

---

## INC-003 — OpenRouter key is dead

**Symptom.** `openai/gpt-oss-120b:free` fails with `401 User not found`.

**Root cause.** Key revoked or expired. (Not a code issue.)

**Fix.** Recreate the key in the OpenRouter dashboard. Until then that catalog
entry is unusable and `/models` lists a broken option.

**Lesson.** A catalog entry that can never succeed is worse than a missing one —
users blame the tool. Provider keys should be validated at startup, not first use.

---

## INC-004 — default model pinned to a single provider

**Symptom.** The same `403` for every user regardless of which other models exist.

**Root cause.** `DEFAULT_CHAT_MODEL_ID` was a compile-time constant bound to one
provider, and `resolveChatModel` has no fallback: one unreachable provider means
100% of turns fail.

**Fix.** Default moved to `deepseek-flash`; README (both languages) documents why.

**Measured blast radius** — 15 catalog models, one tool-calling request each:

| policy | reachable |
|---|---|
| no fallback (single provider, hard-bound) | **2/15 (13%)** |
| fallback to `deepseek-flash` → `deepseek-v4-pro` | **15/15 (100%)** |

Failure latency is bimodal, which drives the failover design:

- **8 fast failures** (`403`/`401`, 0.2–0.9 s) — cheap to fall through
- **5 slow failures** (connect hang, full 12 s timeout) — expensive

**Lesson.** Changing the default is a patch, not a fix. A per-attempt timeout is
mandatory before a fallback chain is worth having: without it one hung provider
delays failover by the full timeout budget. And a silent downgrade
(`claude-opus` → `deepseek-flash`) changes capability, so the transcript must
record the downgrade rather than pretend the request succeeded as asked.

---

## INC-005 — `.env` breaks under shell sourcing

**Symptom.** `source .env` prints `JWT_SECRET: command not found`.

**Root cause.** `JWT_SECRET =value` — whitespace before `=`. Bun's loader tolerates
it; POSIX shells parse the line as a command.

**Fix.** Write `KEY=value` with no spaces.

**Lesson.** An env file that Bun accepts but a shell rejects hides failures in
every script that reads it the other way. Pick one format and enforce it.

---

## INC-006 — failover was measured but not implemented

**Symptom.** After INC-004 the default model changed, but every non-DeepSeek model
still failed permanently. The bench could *describe* the fix without the product
having it.

**Root cause.** Two separate gaps:

1. `chatFetch` rethrew a bare `Error(message)`, **dropping the HTTP status**, so no
   caller could tell a retryable 403 from a permanent 400.
2. There was no chain at all — one model, one provider, one attempt.

**Fix.**

- `packages/cli/src/lib/provider-chain.ts` — chain building, failure classification,
  retry orchestration. Pure, no I/O.
- `packages/cli/src/lib/chat-fetch.ts` — SaaS transport retries the next model by
  rewriting only the `model` field of the request body.
- `packages/cli/src/lib/local-chat-transport.ts` — BYOK retries **before the first
  UI chunk arrives**; once a chunk is emitted the turn is visible and is never replayed.
- Downgrade is explicit: `{color.error}` segment in the status line plus a toast.

**Opt-in by design.** Failover only runs when `MOCODE_ALLOW_MODEL_FAILOVER=1`: retrying on
another provider ships the user's code to a vendor they did not choose, and that is a
decision, not a default. The chain is also `deepseek-flash` only — `deepseek-v4-pro`
costs roughly 4× and is never auto-escalated.

**Measured end-to-end** (real requests, wall clock includes the failed attempt):

| primary asked | answered by | total |
|---|---|---|
| `claude-sonnet-4-6` | `deepseek-flash` (downgraded) | 1.3 s |
| `gpt-oss-120b` | `deepseek-flash` (downgraded) | 1.1 s |
| `deepseek-flash` | `deepseek-flash` (no downgrade) | 1.0 s |

Failover overhead on a fast-failing provider is ~0.1–0.3 s, because a 403 returns
before any token is generated.

**What is deliberately NOT retried:**

| case | retried | why |
|---|---|---|
| 401 / 403 / 429 / 5xx | yes | another provider may serve the request |
| 400 | no | the request body is wrong — retrying hides our own bug |
| user abort (Esc) | no | a cancellation must not be "helpfully" undone |
| timeout | yes | a hung provider should not end the turn |

**Lesson.** Retrying is only safe if you can tell *when the work started*. Here the
boundary is the first UI chunk: before it, nothing has been rendered or billed; after
it, a retry would duplicate both.

---

## INC-007 — failover never fired: the error was hiding inside a 200

**Symptom.** With everything from INC-006 in place, selecting a blocked model still
produced a bare `Forbidden` — no retry, no downgrade toast, no `fallback` segment.

**Root cause.** The failover trigger was `!response.ok`, and the server answers
**200** for every chat request: it opens an SSE stream, then the upstream provider
failure arrives as an `error` event *inside that stream*. A status-code check
therefore saw success and returned the broken stream untouched.

Unit tests passed because they asserted on HTTP statuses; the real transport never
produces a non-2xx status for a provider failure. The test was measuring the wrong
thing.

**Fix.** `chat-fetch.ts` now peeks at the first events of a 200 stream before
returning it:

- an `error` event within the first `PEEK_MAX_CHUNKS` events → treat as a failed
  attempt and fail over
- a healthy event (`text-delta`, `tool-input-start`, `finish`, …) → stop peeking
  and replay every buffered byte into a reconstructed `Response`

Nothing is dropped: the buffered chunks are re-emitted first, and the remaining
reader is pumped into a new `ReadableStream` with the original headers (minus
`content-length` / `content-encoding`).

**Lesson.** "The request succeeded" and "the provider worked" are different
questions once you stream. Any retry policy keyed on HTTP status is wrong for an
SSE endpoint whose errors travel in-band.

---

## INC-008 — fix landed, then the agent timed out mid-reply

**Symptom.** After INC-007 the failover toast and the `fallback → deepseek-flash`
segment appeared correctly, the loop ran (status line showed `turn 12/24`), and then
the reply was replaced with `The operation timed out.`

**Root cause.** The per-attempt deadline was passed straight to `fetch` as an abort
signal, so it kept ticking for the **whole stream**, not just the connection. Any
turn that streamed longer than `attemptTimeoutMs` (20 s) was killed mid-sentence —
including healthy turns that had already emitted dozens of tokens.

The failover logic itself was fine; the deadline was scoped wrong.

**Fix.** The deadline now covers *connect + first useful event* only:

- a cancellable `AbortController` + `setTimeout` replaces `AbortSignal.timeout`
- once a healthy event is seen, `clearTimeout` releases the stream to run as long
  as it needs
- if the deadline fires before that, it is re-thrown as a `TimeoutError` so
  `classifyFailover` still treats it as retryable
- a genuine user abort (`init.signal`) is checked first and never retried

**Regression test.** A stream that emits its first event immediately and its last
chunk 150 ms later, with `attemptTimeoutMs: 50`, must still deliver the late chunk.

**Lesson.** A timeout has to name *what it bounds*. "Request timed out" is
meaningless for a streaming API; the only useful deadlines are "time to first
byte" and "time between tokens".

---

## INC-009 — every sandboxed shell died with SIGABRT and no stderr

**Symptom.** On the first machine where seatbelt actually worked, *every* bash call
returned empty output with `exitCode: null`, `signalCode: SIGABRT`, and an empty
stderr. The capability probe itself passed, so the sandbox looked available.

From the agent's side this was the worst possible failure: a tool that returns
`{stdout: "", stderr: ""}` and no error teaches the model to invent output.

**Diagnosis.** `SIGABRT` with no stderr is not a policy denial — a denial exits
non-zero and says `Operation not permitted`. The bisect isolated the variables:

| # | profile | env | result |
|---|---|---|---|
| 1 | trivial | inherited | ok |
| 2 | trivial | allowlisted | ok |
| 3 | full | inherited | ok |
| 4 | full | allowlisted | ok |

Both inputs were innocent, which pointed at the *spawn*, not the profile.

**Root cause.** `spawnPlan` returned the bare name `"sandbox-exec"`.
`Bun.spawn` resolves a bare name against the env it is handed — and we hand it a
deliberately minimal allowlist. Switching to `/usr/bin/sandbox-exec` fixed every
variant. The exact reason a resolution miss surfaces as `SIGABRT` rather than
`ENOENT` is **not explained**; the empirical evidence is that the path was the only
changed variable, and the failure disappeared.

**Fix.** Absolute paths for sandbox binaries, plus two guards:

- a spawn failure now throws `Shell could not start (<backend> sandbox): …` instead
  of returning an empty result
- a shell killed by a signal now throws `Shell terminated by <SIG> — the <backend>
  sandbox failed to apply` instead of returning empty output

**Verified on macOS** (seatbelt active):

```
head -1 /etc/passwd  →  exit 1, "head: /etc/passwd: Operation not permitted"
echo $MOCODE_DOCTOR_CANARY → "absent"
```

**Lesson.** "No output" is not a diagnosis. Two independent failure modes produced
identical empty results — a broken sandbox and a working sandbox with a missing
variable — and only exit code, signal, and stderr told them apart. Any tool that can
return empty should be able to say *why* it was empty.

---

## Open follow-ups

1. **Per-attempt timeout** is wired in the SaaS path only; BYOK still relies on the
   provider SDK's own deadline.
2. **Four-rate DeepSeek pricing** (cache × peak) instead of the two-field model.
3. **Downgrade is per-turn state**, not persisted into session history — reopening a
   session loses the record that a fallback answered.

