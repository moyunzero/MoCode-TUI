# Agent permissions (Build mode)

MoCode separates **who enforces permissions** from **who invokes shell commands**, aligned with Claude Code harness behavior.

## CLI TUI is the permission gate

Dangerous bash commands are blocked by a **blocklist** in the CLI (`packages/cli/src/lib/bash-approval.ts`, via `requiresApproval()` called from `use-chat.ts`), not by the model asking in chat. When a command matches the blocklist:

1. Execution pauses before the command runs.
2. A TUI modal appears: **Approve once** / **Reject** / **Allow for this session**.
3. Keyboard navigation: **↑ / ↓** to move, **Enter** to confirm, **Esc** to reject.

Non-blocklisted commands (e.g. `npm test`, `git status`) run immediately with no dialog.

## Model behavior

In Build mode the model should:

- **Invoke bash directly** for shell work — do not ask in chat whether to run a command first.
- Treat the **TUI approval dialog as the sole confirmation** for dangerous commands; chat messages are not a permission gate.
- **Not retry** a rejected command unless the user explicitly asks again. On rejection, acknowledge and suggest alternatives.
- Use the optional **`description`** field on bash tool calls when the command string alone does not convey intent (shown as a dim line in the transcript).

## Plan mode

Plan mode has no bash tool. Git inspection uses read-only `gitStatus` and `gitDiff` tools instead.

## Enforcement layers

Permission is not one check — it is four, applied in order. Each layer assumes the
previous one may have been bypassed, which is why Plan mode is enforced twice.

| Layer | Where | What it stops |
|---|---|---|
| 1. Tool contracts | `packages/shared/src/schemas.ts` (`getToolContracts`) | Plan mode never *receives* write/bash tool definitions |
| 2. Executor mode gate | `packages/cli/src/lib/local-tools.ts` (`READ_ONLY_TOOLS`) | A write tool that leaked through is still rejected before touching disk |
| 3. Path containment | `packages/cli/src/lib/sandbox-path.ts` | `../../etc/passwd`, absolute paths, and **symlinks pointing outside the project** — **file tools only** |
| 4. Hard denies | `packages/cli/src/lib/permission-rules.ts` (`findHardDeny`) | Host-destroying commands — refused **even after the user clicks approve** |

### Layer 0: the OS sandbox (the only thing that contains a shell)

Layers 1–3 are path checks, and **a path check cannot contain a shell**. That was
not a theory: manual acceptance caught the agent running

```
Bash: head -3 secret.txt      # secret.txt -> /etc/passwd
##
# User Database
```

which bypassed `readFile` entirely and printed `/etc/passwd`. The file tools were
fenced; the shell was not.

So the outermost layer is an OS sandbox, applied at spawn:

| host | shell process |
|---|---|
| seatbelt applies (macOS) | `sandbox-exec -p <profile> bash -c …`, `(deny default)` |
| bwrap applies (Linux) | `bwrap --ro-bind / / --bind <cwd> <cwd> … bash -c …` |
| neither | `bash -c …`, **unconfined** — every command needs approval |

Verified on macOS with seatbelt active — the original exploit, replayed:

```
$ ln -s /etc/passwd secret.txt
$ head -3 secret.txt
head: secret.txt: Operation not permitted   (exit 1)

readFile("secret.txt") → Path is outside the project directory
```

Both independent guards refuse, and neither asks for approval first: the command is
not blocklisted, the shell is confined, so it simply runs and the **kernel** denies
the read. That distinction matters — a denial that arrives as an approval prompt is
a policy, a denial that arrives as `EPERM` is a boundary.

**Without a working OS sandbox there is no containment, only gating.** The approval
policy says so explicitly: when `isShellConfined()` is false, every bash command
asks, because a blocklist in front of an unconfined shell is theatre.

### Capability tracking: `available` vs `enforced`

`sandbox-capability.ts` probes the host at first use (seatbelt on macOS, bwrap on
Linux) and reports two separate flags:

| flag | meaning |
|---|---|
| `available` | the host *can* apply a sandbox — a trivial profile actually ran |
| `enforced` | the spawn site *does* apply it to shell commands |

The spawn site now wraps the shell when both flags hold:

| host | shell command | approval |
|---|---|---|
| seatbelt/bwrap applies | `sandbox-exec -p <profile> bash -c …` / `bwrap … bash -c …` | blocklist only |
| nothing applies | `bash -c …` | **every** command asks |

When the shell is confined, `head -3 secret.txt` fails with a seatbelt denial —
the content never reaches the model. When it is not confined, the run still
happens but each command needs a human, because a blocklist alone is theatre.

### Profile policy

Seatbelt denies by default and allows only:

- **read**: `/` in general — a narrow allowlist made dyld/cryptex hosts abort at
  startup, so the rule is a broad allow followed by an explicit deny list
- **denied read**: `/etc/passwd`, `/etc/shadow`, `/etc/sudoers`, `/root`,
  `/var/root`, plus `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`,
  `~/.config/gh`, `~/.config/gcloud`, `~/.npmrc`, `~/.yarnrc`, `~/.pypirc`,
  `~/.netrc`
- **write**: project tree, `$TMPDIR`, `/dev/null`, `/dev/tty`, plus
  `MOCODE_SANDBOX_EXTRA_WRITE`

`$HOME` is **not** unreadable as a whole — only the listed credential trees are.
If you add a tool that stores tokens somewhere new, add that path to
`deniedReadPaths`; the deny list is the boundary, not the absence of an allow rule.

bwrap cannot express "deny by default" without rebuilding the root, so it mounts a
read-only `/` with a writable project and masks `~/.ssh`, `~/.aws`, `~/.gnupg`,
`/etc/shadow` and friends onto `/dev/null`.

### Verifying confinement

```bash
# 1. What does this host report?
bun run packages/cli/scripts/acceptance.ts   # prints the capability line

# 2. Does the fence actually hold?
#    Ask the agent to run:  bash: head -1 /etc/passwd
#    Confined  → "Operation not permitted" (seatbelt), no content
#    Unconfined → content returned, and the command required approval first
```

`MOCODE_DISABLE_SANDBOX=1` turns confinement off for tools that break under
seatbelt; the approval policy notices and goes back to asking for everything.
`MOCODE_ALLOW_UNCONFINED_SHELL=1` is the separate, explicit "I accept an
unconfined shell, stop asking" switch.

### Layer 3: containment is checked twice

The old check was lexical only, so a symlink inside the project defeated it:

```bash
ln -s /etc ./docs      # docs lives inside the project
readFile("docs/passwd") # lexically inside, actually /etc/passwd
```

`resolveInsideCwd` now also compares **real paths** of the deepest existing
ancestor, which works for files that do not exist yet (`writeFile` creating a new
directory tree).

### Layer 4: approval is not a licence

Approval exists for *destructive but legitimate* work (`rm -rf ./dist`). It does
not extend to `mkfs`, `dd of=/dev/…`, `rm -rf /`, or a fork bomb — the executor
refuses those before spawning, so a mistaken "approve" cannot format a disk.

### Shell environment is an allowlist

The spawned shell receives only the keys in `SANDBOX_ENV_KEYS` (`PATH`, `HOME`,
`LANG`, `SHELL`, `TMPDIR`, …) with `TERM=dumb`. Every secret the CLI was started
with — `DEEPSEEK_API_KEY`, `CLERK_SECRET_KEY`, `DATABASE_URL` — is absent from the
child process. Previously bash inherited all of `process.env`.

### Refusal codes and audit trail

A refusal the model merely *reasons about* is not a control — the model can be
argued out of it. The executor is the authority, and every decision it makes is
recorded.

Refusals raise `ToolPermissionError` with a machine-readable code:

| code | meaning |
|---|---|
| `PATH_ESCAPE` | resolved path left the project (lexically or via symlink) |
| `HARD_DENY` | host-destroying command, not approvable |
| `MODE_DENIED` | tool not available in the current mode |
| `UNKNOWN_TOOL` | tool name is not in the executor's switch |

The message stays human-readable for the model; the code is what dashboards and
audits group by. Prose drifts, codes do not.

Every call — allowed, refused, or failed — appends one JSONL line to
`~/.mocode/audit.jsonl` (override with `MOCODE_AUDIT_PATH`):

```json
{"timestamp":"2026-11-11T13:40:02.114Z","tool":"readFile","mode":"BUILD","outcome":"denied","code":"PATH_ESCAPE","detail":"path=/etc/passwd"}
```

Three rules make the log safe to keep:

1. **No file contents.** Only short single-line scalars are summarised; anything
   longer than 120 chars or containing a newline is dropped, not truncated.
2. **Never breaks a call.** A full disk or read-only home returns `false` instead
   of throwing — losing a log line must not fail a working tool.
3. **One line per decision**, append-only, `jq`-friendly.

### Rotation

An unbounded audit file is its own outage. The log rotates before each append:

| | default | override |
|---|---|---|
| rotate at | 5 MB | `MOCODE_AUDIT_MAX_BYTES` |
| archives kept | 5 | `MOCODE_AUDIT_MAX_FILES` |

Archives are numbered newest-first — `audit.jsonl.1` holds the most recent rotated
segment and `.N` the oldest, which is dropped on the next rotation. Disk cost is
therefore bounded: `maxBytes × (maxFiles + 1)`.

Rotation is size-triggered rather than time-triggered on purpose: a CLI process may
live for minutes or for a day, and time-based cutoffs either lose the burst or
create dozens of empty files.

**Known limit:** rotation is a rename done synchronously in-process. Two CLI
processes sharing one `~/.mocode` could race; the loser appends to a file that was
just rotated away. Acceptable for a single-user CLI, not for a shared agent host —
that needs an append-only sink (file → log shipper), not a local file.

### User rules

The built-in policy is a floor, not the whole story: a team needs to say "never
`git push` here" or "always allow `npm test`" without patching source.

Rules live in JSON, so they are reviewable and diffable:

```jsonc
// <project>/.mocode/permissions.json   — committed with the repo
// ~/.mocode/permissions.json           — applies to every project
{
  "rules": [
    { "tool": "bash", "pattern": "^git push", "behavior": "deny" },
    { "tool": "bash", "pattern": "^npm (test|run lint)", "behavior": "allow" },
    { "tool": "writeFile", "behavior": "ask" }
  ]
}
```

| field | meaning |
|---|---|
| `tool` | exact tool name, or `*` |
| `pattern` | optional JS regex tested against the command (bash) or path (file tools) |
| `behavior` | `allow` / `deny` / `ask` |

**Precedence is deny > allow > ask**, and a `deny` in either file wins over an
`allow` in the other — a safety rule must not be defeatable by a broader allow.
Within one behaviour the first matching rule wins, so the file reads top-down.

Enforcement happens in two places on purpose:

1. the **approval gate** — `deny` returns immediately without showing a dialog,
   `allow` skips the built-in dialog, `ask` forces one;
2. the **executor** — `deny` throws `RULE_DENIED` and is audited, so a caller that
   never goes through the UI (evals, subagents) is still bound by the policy.

A malformed rule is **dropped and reported**, never coerced: turning
`"behavior": "denied"` into an allow would be the worst possible failure. Rules are
re-read on every call, so an edit applies to the next tool call without a restart.

**Not implemented yet:** writing rules back from the TUI ("always allow for this
project"). The approval dialogs still record session-only allows; persisting them
would need a new dialog action.

### Regression suite

`packages/cli/src/lib/local-tools.sandbox.test.ts` runs the attack cases against the
real `executeLocalTool` entry point:

- absolute path, parent traversal, write-outside, list-outside → all refused
- `dd of=/dev/…` and `mkfs` → refused at execution time
- a canary `DEEPSEEK_API_KEY` is invisible to the shell
- `PATH` still works, `TERM` is `dumb`
- Plan mode still rejects write/bash even if the contract leaked
- every refusal is logged with its code; a 500-char file body never reaches the log

Manual check: ask the agent to read `/etc/passwd` — it must report a refusal, not
content. Then approve a `mkdir` (should run) and approve `mkfs.ext4 /dev/null`
(should be refused with "cannot be approved").

 