# Task evals

The only measurement in this repo that scores **end-to-end task success** rather
than unit-level correctness. Everything else (340+ unit tests) proves the pieces
work; this proves the agent can do a job.

## Run

```bash
bun run packages/cli/evals/run.ts                    # all cases
bun run packages/cli/evals/run.ts --only fix-off-by-one
```

Needs `DEEPSEEK_API_KEY` in `.env`. Each case gets a throwaway temp directory; the
agent's cwd is switched into it so the sandbox still applies. Results land in
`evals/results/latest.json`.

## What a case is

```ts
{
  id, category,
  prompt,               // what the user asks
  files,                // starting state, written to a temp dir
  check,                // shell command that must exit 0
}
```

The check is **behavioural** — it runs code and asserts on results, not on the
presence of a string. `rename-across-files` would otherwise pass on a no-op.

## The meta-test is the important one

`evals/cases.test.ts` asserts, for every case, that **the check fails in the initial
state**. A case that already passes measures nothing but a false success rate.

This caught a real defect while the suite was being written: `fix-async-ordering`
initially passed because the microtasks settled before the assertion ran, so the
"broken" code produced the right answer. The fix was to snapshot the array before
the promises resolve.

## Latest run

20 cases: the ten single-file ones below, plus ten harder ones (multi-file
propagation, a regression on a neighbouring test, an O(n²)→budget rewrite, a test
the agent is forbidden to edit, immutability, error contract, state cycle,
multi-constraint, cascading order-of-operations bug).

**20/20 (100%)**, average 6 turns · 8 tool calls · ~15.5k tokens.
Heaviest case: `dedupe-into-helper`, 12 turns / 49k tokens / 26 s.

A second independent run on a different machine landed at the same 20/20 with
7 turns · 9 tools · ~18.4k tokens per case. The spread (15.5k → 18.4k) is normal
run-to-run variance for the same model — which is why the report stores per-case
numbers rather than a single average.

The first ten (model `deepseek-flash`, max 15 turns per case):

| case | ok | turns | tools | tokens | time |
|---|---|---|---|---|---|
| fix-off-by-one | ✅ | 4 | 3 | 6,269 | 6.1 s |
| fix-missing-await | ✅ | 7 | 9 | 18,346 | 15.8 s |
| implement-stub | ✅ | 5 | 6 | 9,910 | 6.3 s |
| add-validation | ✅ | 5 | 6 | 11,792 | 10.4 s |
| fix-json-crash | ✅ | 5 | 6 | 9,332 | 5.9 s |
| rename-across-files | ✅ | 6 | 10 | 12,599 | 7.4 s |
| dedupe-into-helper | ✅ | 12 | 16 | 49,128 | 26.4 s |
| add-unit-test | ✅ | 5 | 7 | 9,723 | 5.1 s |
| fix-async-ordering | ✅ | 11 | 12 | 33,271 | 18.9 s |
| add-cli-flag | ✅ | 5 | 5 | 9,152 | 5.8 s |

## Being honest about 100%

Adding ten harder cases did not move the score. That is the finding, not a
failure to report: **this class of micro-task does not discriminate** for a
current-generation coding model. A perfect score here is a floor, not a ceiling.

What the twenty cases still do not reproduce:

- **repo-scale context** — a file the agent must find among hundreds, not one it
  is handed by name
- **vague reports** — "checkout is sometimes wrong" instead of a failing assert
- **hidden coupling** — the fix passes the visible test but breaks a caller the
  agent never read
- **long horizons** — tasks that legitimately need 40+ turns
- **the ask-don't-guess path** — where the correct action is to stop and ask

The next lever is **realistic fixtures and ambiguity**, not more micro-cases. Ten
more single-file tasks would keep the score at 100% and teach nothing.

One thing the harder set did buy: `fix-async-ordering` and `dedupe-into-helper`
now take 11–12 turns, so the suite exercises multi-step recovery rather than
one-shot edits.

## Manual acceptance

1. `bun run packages/cli/evals/run.ts` — expect 10/10 and a JSON report.
2. Deliberately break something cheap: set `MAX_TURNS=1` in `run.ts`.
   Expected: cases now fail with check exit ≠ 0, proving the score tracks the
   agent rather than the fixture.
3. Remove `clamp.ts` from the `add-unit-test` fixture in `EVAL_CASES` (not from a
   temporary run directory) and re-run `--only add-unit-test`. Expected: the agent
   reports that the module is missing instead of inventing an import — that is the
   tool-error path working. Note that the prompt says "add tests for clamp()", so
   the agent may instead *recreate* `clamp.ts`; treat that as an acceptable
   outcome and judge the tool-error path on the cases where it does not.

## What it costs

The full suite is ~1 minute and a few cents. Cheap enough to run before a demo and
after any change to the loop, tools, or context policy — which is the point: an
eval you don't run is a dead document.
