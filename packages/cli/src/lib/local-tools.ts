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
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { toolInputSchemas, Mode, type ModeType } from "@mocode/shared";
import { simpleGit } from "simple-git";
import { runRipgrep } from "./ripgrep";
import { trackToolProcess } from "./tool-process-registry";

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
 * @throws when the resolved absolute path leaves the project directory.
 */
function resolveInsideCwd(path: string) {
  const cwd = process.cwd();
  const resolved = resolve(cwd, path);
  const rel = relative(cwd, resolved);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Path is outside the project directory");
  }

  return { cwd, resolved };
}

/** Append a truncation notice when shell output exceeds {@link MAX_OUTPUT}. */
function truncate(value: string, limit: number) {
  return value.length > limit
    ? `${value.slice(0, limit)}\n... (truncated, ${value.length} total chars)`
    : value;
}

/** Returns a line slice when line_start/line_end are set (1-based, inclusive). */
function sliceFileLines(content: string, lineStart?: number, lineEnd?: number): string {
  if (lineStart === undefined && lineEnd === undefined) {
    return content;
  }

  const lines = content.split("\n");
  const startIndex = Math.max(1, lineStart ?? 1) - 1;
  const endIndex = lineEnd === undefined ? lines.length : Math.min(lineEnd, lines.length);
  if (endIndex < startIndex + 1) {
    return "";
  }

  return lines.slice(startIndex, endIndex).join("\n");
}

/**
 * Dispatch a single tool call to the matching local handler.
 *
 * @param toolName - Key from {@link ToolContracts} (e.g. `"readFile"`, `"bash"`).
 * @param input - Raw tool input from the model; validated per-tool via Zod.
 * @param mode - Session mode; PLAN rejects write/bash tools as a second guard
 *   (the server already omits them from `getToolContracts(PLAN)`).
 */
export async function executeLocalTool(toolName: string, input: unknown, mode: ModeType) {
  if (
    mode === Mode.PLAN &&
    !READ_ONLY_TOOLS.includes(toolName as (typeof READ_ONLY_TOOLS)[number])
  ) {
    throw new Error(`Tool ${toolName} is not available in PLAN mode`);
  }

  switch (toolName) {
    case "readFile": {
      const { path, line_start, line_end } = toolInputSchemas.readFile.parse(input);
      const { resolved } = resolveInsideCwd(path);
      const raw = await readFile(resolved, "utf-8");
      const content = sliceFileLines(raw, line_start, line_end);
      return content.length > MAX_FILE_SIZE
        ? { content: content.slice(0, MAX_FILE_SIZE), truncated: true, totalLength: content.length }
        : { content };
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
      // Runs in the sandboxed project cwd; TERM=dumb avoids escape-sequence noise in the TUI.
      const { command, timeout = DEFAULT_TIMEOUT } = toolInputSchemas.bash.parse(input);
      const proc = Bun.spawn(["bash", "-c", command], {
        cwd: resolveInsideCwd(".").resolved,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, TERM: "dumb" },
      });
      trackToolProcess(proc);
      const timer = setTimeout(() => proc.kill(), timeout);
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      clearTimeout(timer);
      return {
        stdout: truncate(stdout, MAX_OUTPUT),
        stderr: truncate(stderr, MAX_OUTPUT),
        exitCode,
      };
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
};