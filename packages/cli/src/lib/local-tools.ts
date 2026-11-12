/**
 * Phase 11 — Client-side tool execution.
 *
 * Tools previously ran on the server (`packages/server/src/tools/*`). Phase 11
 * moves execution to the CLI so file I/O and shell commands run in the user's
 * local project directory (`process.cwd()`), not on the remote server.
 *
 * Flow:
 * 1. Server streams tool-call SSE events from `streamText({ tools })` using
 *    contracts from {@link getToolContracts} in `@mocode/shared`.
 * 2. `useChat.onToolCall` invokes {@link executeLocalTool} here.
 * 3. Result is sent back via `chat.addToolOutput`, triggering auto-resubmit
 *    when all pending tool calls are complete.
 *
 * Security: every path is resolved and checked against `process.cwd()` so the
 * agent cannot read or write outside the project tree.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { toolInputSchemas, Mode, type ModeType } from "@mocode/shared";
import { simpleGit } from "simple-git";
import { runRipgrep } from "./ripgrep";
import { trackToolProcess } from "./tool-process-registry";
import { resolveInsideCwd as resolveSafePath } from "./sandbox-path";
import { ToolPermissionError, buildSandboxEnv, findHardDeny } from "./permission-rules";
import { recordAudit, summarizeInput } from "./audit-log";
import { isShellConfined, sandboxBackend } from "./sandbox-capability";
import { parsePathList, runtimePaths, spawnPlan } from "./sandbox-profile";

/** Max chars returned from readFile before truncation metadata is attached. */
const MAX_FILE_SIZE = 10_000;
/** Max file paths returned by glob before `truncated: true`. */
const MAX_RESULTS = 200;
/** Max stdout/stderr chars returned from bash before truncation. */
const MAX_OUTPUT = 20_000;
/** Default bash subprocess timeout in milliseconds. */
const DEFAULT_TIMEOUT = 30_000;

/** Tools allowed in PLAN mode (read-only). Phase 01 added gitStatus/gitDiff (HARNESS-02). */
const READ_ONLY_TOOLS = [
  "readFile",
  "listDirectory",
  "glob",
  "grep",
  "gitStatus",
  "gitDiff",
] as const;

/**
 * Resolve `path` relative to `process.cwd()` and reject escapes outside it.
 *
 * Containment is checked twice — lexically and against real paths — so a symlink
 * inside the project cannot point at `/etc`. See `sandbox-path.ts`.
 *
 * @throws when the resolved absolute path leaves the project directory.
 */
function resolveInsideCwd(path: string) {
  const cwd = process.cwd();

  try {
    return { cwd, resolved: resolveSafePath(cwd, path) };
  } catch (error) {
    throw new ToolPermissionError(
      "PATH_ESCAPE",
      error instanceof Error ? error.message : "Path is outside the project directory",
    );
  }
}

/** Append a truncation notice when shell output exceeds {@link MAX_OUTPUT}. */
function truncate(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit)}\n... (truncated, ${value.length} total chars)`
    : value;
}


/**
 * Streams only the requested line range.
 *
 * Keeps at most `limit` characters of output while still counting the full
 * selected range length, so truncation metadata stays accurate without holding
 * the entire selection in memory.
 */
async function readLinesFromFile(
  resolved: string,
  lineStart?: number,
  lineEnd?: number,
  limit: number = MAX_FILE_SIZE,
): Promise<{ content: string; truncated?: boolean; totalLength?: number }> {
  const startLine = lineStart ?? 1;
  const lines: string[] = [];
  const rl = createInterface({
    input: createReadStream(resolved, { encoding: "utf-8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  let lineNumber = 0;
  let selectedLength = 0;
  let keptLength = 0;
  let truncated = false;
  // Length is not a proxy for "a line has been selected": the first selected line
  // may be empty, and then the *second* line would not count its separator.
  let hasSelected = false;
  let hasKept = false;

  for await (const line of rl) {
    lineNumber += 1;
    if (lineNumber < startLine) continue;
    if (lineEnd !== undefined && lineNumber > lineEnd) break;

    selectedLength += (hasSelected ? 1 : 0) + line.length;
    hasSelected = true;

    if (truncated) continue;

    const nextKept = keptLength + (hasKept ? 1 : 0) + line.length;
    if (nextKept <= limit) {
      lines.push(line);
      keptLength = nextKept;
      hasKept = true;
      continue;
    }

    const remaining = limit - keptLength - (hasKept ? 1 : 0);
    if (remaining > 0) lines.push(line.slice(0, remaining));
    keptLength = limit;
    truncated = true;
  }

  const content = lines.join("\n");
  return truncated ? { content, truncated: true, totalLength: selectedLength } : { content };
}

/** Streams file content up to a character limit — avoids loading entire large files. */
async function readFileUpToCharLimit(
  resolved: string,
  limit: number,
): Promise<{ content: string; truncated: boolean }> {
  const stream = createReadStream(resolved, { encoding: "utf-8" });
  const chunks: string[] = [];
  let length = 0;
  let truncated = false;

  for await (const chunk of stream) {
    const text = String(chunk);
    if (length + text.length <= limit) {
      chunks.push(text);
      length += text.length;
      continue;
    }

    const remaining = limit - length;
    if (remaining > 0) {
      chunks.push(text.slice(0, remaining));
      length += remaining;
    }
    truncated = true;
    stream.destroy();
    break;
  }

  return { content: chunks.join(""), truncated };
}

/**
 * Dispatch a single tool call to the matching local handler.
 *
 * @param toolName - Key from {@link ToolContracts} (e.g. `"readFile"`, `"bash"`).
 * @param input - Raw tool input from the model; validated per-tool via Zod.
 * @param mode - Session mode; PLAN rejects write/bash tools as a second guard
 *   (the server already omits them from `getToolContracts(PLAN)`).
 */
async function runTool(toolName: string, input: unknown, mode: ModeType) {
  if (
    mode === Mode.PLAN &&
    !READ_ONLY_TOOLS.includes(toolName as (typeof READ_ONLY_TOOLS)[number])
  ) {
    throw new ToolPermissionError("MODE_DENIED", `Tool ${toolName} is not available in PLAN mode`);
  }

  switch (toolName) {
    case "readFile": {
      const { path, line_start, line_end } = toolInputSchemas.readFile.parse(input);
      const { resolved } = resolveInsideCwd(path);

      if (line_start !== undefined || line_end !== undefined) {
        return readLinesFromFile(resolved, line_start, line_end, MAX_FILE_SIZE);
      }

      const { content, truncated } = await readFileUpToCharLimit(resolved, MAX_FILE_SIZE);
      return truncated ? { content, truncated: true } : { content };
    }
    case "listDirectory": {
      const { path } = toolInputSchemas.listDirectory.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const entries = await readdir(resolved);
      const results: { name: string; type: "file" | "directory" }[] = [];

      // Skip dotfiles and node_modules to keep listings focused and fast.
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        const info = await stat(join(resolved, entry));
        results.push({ name: entry, type: info.isDirectory() ? "directory" : "file" });
      }

      results.sort((a, b) =>
        a.type !== b.type ? (a.type === "directory" ? -1 : 1) : a.name.localeCompare(b.name),
      );
      return { path: relative(cwd, resolved) || ".", entries: results };
    }
    case "glob": {
      const { pattern, path } = toolInputSchemas.glob.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const glob = new Bun.Glob(pattern);
      const files: string[] = [];
      let truncated = false;

      for await (const match of glob.scan({ cwd: resolved, dot: false, onlyFiles: true })) {
        if (match.includes("node_modules")) continue;
        if (files.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
        files.push(relative(cwd, resolve(resolved, match)));
      }

      files.sort();
      return { files, ...(truncated ? { truncated: true } : {}) };
    }
    case "grep": {
      // Phase 01 (HARNESS-01): delegates to ripgrep instead of naive file scan.
      // Tool name stays "grep" for model compatibility; implementation is runRipgrep.
      const { pattern, path, include } = toolInputSchemas.grep.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      return runRipgrep(cwd, resolved, pattern, include);
    }
    case "gitStatus": {
      // Phase 01 (HARNESS-02): read-only git inspection via simple-git.
      // Prefer this over `bash git status` — structured output, no shell spawn.
      const git = simpleGit(process.cwd());
      if (!(await git.checkIsRepo())) throw new Error("Not a git repository");

      const status = await git.status();
      const unstaged =
        status.modified.length +
        status.deleted.length +
        status.renamed.length +
        status.created.length +
        status.conflicted.length;
      return {
        branch: status.current,
        tracking: status.tracking ?? null,
        clean: status.isClean(),
        staged: status.staged.length,
        unstaged,
        untracked: status.not_added.length,
        summary: status.isClean()
          ? `On branch ${status.current}: working tree clean`
          : `On branch ${status.current}: ${status.staged.length} staged, ${unstaged} unstaged, ${status.not_added.length} untracked`,
      };
    }
    case "gitDiff": {
      // staged takes priority over ref when both are provided (schema contract).
      // Default (neither set): unstaged working-tree diff.
      const { staged, ref } = toolInputSchemas.gitDiff.parse(input);
      const git = simpleGit(process.cwd());
      if (!(await git.checkIsRepo())) throw new Error("Not a git repository");

      const diffArgs = staged ? ["--cached"] : ref ? [ref] : [];
      const diff = await git.diff(diffArgs);
      const truncated = diff.length > MAX_OUTPUT;
      return {
        diff: truncated ? diff.slice(0, MAX_OUTPUT) : diff,
        ...(truncated ? { truncated: true, totalLength: diff.length } : {}),
      };
    }
    case "writeFile": {
      const { path, content } = toolInputSchemas.writeFile.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, content, "utf-8");
      return {
        success: true as const,
        path: relative(cwd, resolved),
        bytesWritten: Buffer.byteLength(content, "utf-8"),
      };
    }
    case "editFile": {
      // Require exactly one match so the model must include enough surrounding context.
      const { path, oldString, newString } = toolInputSchemas.editFile.parse(input);
      const { cwd, resolved } = resolveInsideCwd(path);
      const content = await readFile(resolved, "utf-8");
      const occurrences = content.split(oldString).length - 1;

      if (occurrences === 0) throw new Error("oldString not found in file");
      if (occurrences > 1) throw new Error(`oldString is ambiguous; found ${occurrences} matches`);

      await writeFile(resolved, content.replace(oldString, newString), "utf-8");
      return { success: true as const, path: relative(cwd, resolved) };
    }
    case "bash": {
      // Hard denies are refused even when the user approved the command: approval
      // covers destructive-but-legitimate work, not host-destroying commands.
      const { command, timeout = DEFAULT_TIMEOUT } = toolInputSchemas.bash.parse(input);
      const hardDeny = findHardDeny(command);
      if (hardDeny) {
        throw new ToolPermissionError(
          "HARD_DENY",
          `Command refused (${hardDeny.id}): ${hardDeny.reason}. This cannot be approved.`,
        );
      }

      // Runs in the project cwd with an allowlisted env; TERM=dumb avoids escape
      // sequences leaking into the TUI. API keys are deliberately absent.
      //
      // A shell cannot be contained by path checks, so the spawn is wrapped in the
      // host's OS sandbox when one is actually available. When it is not, the run
      // is unconfined and the approval policy requires a human for every command.
      const cwd = resolveInsideCwd(".").resolved;
      const plan = spawnPlan(sandboxBackend(), command, {
        cwd,
        home: process.env.HOME,
        tmpDir: process.env.TMPDIR,
        runtimePaths: runtimePaths(),
        extraReadPaths: parsePathList(process.env.MOCODE_SANDBOX_EXTRA_READ),
        extraWritePaths: parsePathList(process.env.MOCODE_SANDBOX_EXTRA_WRITE),
      });

      // Under bwrap the host TMPDIR is a read-only bind; the plan mounts a private
      // tmpfs at /tmp, so point the child there.
      const childEnv =
        plan.backend === "bwrap" ? { ...buildSandboxEnv(), TMPDIR: "/tmp", TMP: "/tmp" } : buildSandboxEnv();

      const proc = (() => {
        try {
          return Bun.spawn([plan.file, ...plan.args], {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
            env: childEnv,
          });
        } catch (error) {
          // A sandbox that fails to start must not look like "the command printed
          // nothing" — that silently teaches the model to hallucinate output.
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(
            `Shell could not start (${plan.backend} sandbox): ${reason}. ` +
              `Set MOCODE_DISABLE_SANDBOX=1 to run unconfined and diagnose.`,
          );
        }
      })();
      trackToolProcess(proc);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeout);
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timer);

      // Distinguish *why* the shell died. A timeout or a user kill also shows up
      // as a signal; blaming the sandbox for those was wrong and unactionable.
      if (timedOut) {
        throw new Error(`Command timed out after ${timeout}ms and was terminated.`);
      }

      if (proc.signalCode) {
        const sandboxCrash =
          plan.confined && (proc.signalCode === "SIGABRT" || proc.signalCode === "SIGSEGV");

        throw new Error(
          sandboxCrash
            ? `Shell terminated by ${proc.signalCode} — the ${plan.backend} sandbox failed to apply. ` +
                `Set MOCODE_DISABLE_SANDBOX=1 to run unconfined and diagnose.`
            : `Command terminated by signal ${proc.signalCode}.`,
        );
      }
      return {
        stdout: truncate(stdout, MAX_OUTPUT),
        stderr: truncate(stderr, MAX_OUTPUT),
        exitCode,
      };
    }
    default:
      throw new ToolPermissionError("UNKNOWN_TOOL", `Unknown tool: ${toolName}`);
  }
};

/**
 * Authorised tool entry point.
 *
 * Every call — allowed, refused, or failed — leaves exactly one audit line. That is
 * what makes the executor the authority rather than the model: a refusal is a
 * recorded decision, not an absence of attempts.
 *
 * The thrown error keeps a human-readable message for the model while carrying a
 * `PermissionCode` for the log.
 */
export async function executeLocalTool(
  toolName: string,
  input: unknown,
  mode: ModeType,
): Promise<unknown> {
  const detail = summarizeInput(input);
  // Only shells have a containment question; record the answer alongside the call
  // so an audit can distinguish "ran in a sandbox" from "ran unconfined".
  const containment = toolName === "bash" ? { shellConfined: isShellConfined() } : {};

  try {
    const output = await runTool(toolName, input, mode);
    recordAudit({ tool: toolName, mode, outcome: "ok", detail, ...containment });
    return output;
  } catch (error) {
    recordAudit(
      error instanceof ToolPermissionError
        ? { tool: toolName, mode, outcome: "denied", code: error.code, detail, ...containment }
        : { tool: toolName, mode, outcome: "error", detail, ...containment },
    );
    throw error;
  }
}