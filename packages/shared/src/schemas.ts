/**
 * Phase 11 — Shared tool contracts for server streaming and CLI execution.
 *
 * `toolInputSchemas` — Zod shapes used by the CLI to validate inputs before I/O.
 * `readOnlyToolContracts` / `buildToolContracts` — AI SDK `tool()` definitions
 * the server passes to `streamText`; they describe tools to the model only.
 * {@link getToolContracts} selects the set by session mode (PLAN vs BUILD).
 *
 * Keeping schemas and contracts in `@mocode/shared` ensures the model, server,
 * and CLI agree on tool names and argument shapes without duplicating definitions.
 */
import { z } from "zod";
import { tool } from "ai";

export const Mode = {
  BUILD: "BUILD",
  PLAN: "PLAN",
} as const;

export const modeSchema = z.enum([Mode.BUILD, Mode.PLAN]);

export type ModeType = (typeof Mode)[keyof typeof Mode];

/** Zod input schemas keyed by tool name; shared between server contracts and CLI validation. */
export const toolInputSchemas = {
  readFile: z
    .object({
      path: z.string().describe("Relative path to the file to read"),
      line_start: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional 1-based start line (inclusive) for partial reads"),
      line_end: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Optional 1-based end line (inclusive) for partial reads"),
    })
    .refine(
      (data) =>
        data.line_start === undefined ||
        data.line_end === undefined ||
        data.line_start <= data.line_end,
      { message: "line_start must be less than or equal to line_end", path: ["line_end"] },
    ),
  listDirectory: z.object({
    path: z.string().default(".").describe("Relative directory path to list"),
  }),
  glob: z.object({
    pattern: z.string().describe("Glob pattern to match files"),
    path: z.string().default(".").describe("Directory to search from"),
  }),
  grep: z.object({
    pattern: z.string().describe("Regex pattern to search for"),
    path: z.string().default(".").describe("Directory to search from"),
    include: z.string().optional().describe("Optional glob for files to include"),
  }),
  writeFile: z.object({
    path: z.string().describe("Relative path to write"),
    content: z.string().describe("File contents"),
  }),
  editFile: z.object({
    path: z.string().describe("Relative path to edit"),
    oldString: z.string().describe("Exact text to replace; must be unique"),
    newString: z.string().describe("Replacement text"),
  }),
  bash: z.object({
    command: z.string().describe("Shell command to run"),
    // Optional human-readable intent shown dim in TUI transcript (Phase 01, D-24/D-26).
    description: z.string().optional().describe("Short description of the command"),
    timeout: z.number().optional().describe("Timeout in milliseconds"),
  }),
  // Phase 01 (HARNESS-02): no-args read-only git tools, available in PLAN and BUILD.
  gitStatus: z.object({}),
  gitDiff: z.object({
    staged: z.boolean().optional().describe("When true, show staged diff only"),
    ref: z
      .string()
      .refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value))
      .optional()
      .describe(
        "Branch or commit SHA to compare working tree against (ignored when staged is true)",
      ),
  }),
  // Phase 04 (D-01): delegate to a specialized subagent; summary-only result returned to parent.
  task: z.object({
    subagent_type: z
      .enum(["explore", "plan-research"])
      .describe("Builtin subagent to run"),
    prompt: z.string().describe("Task instructions for the subagent"),
    description: z
      .string()
      .optional()
      .describe("Short human-readable label shown in the transcript"),
  }),
} as const;

/** Read-only tools available in PLAN mode (and as a subset of BUILD). */
export const readOnlyToolContracts = {
  readFile: tool({
    description:
      "Read a file from the current project directory. Use line_start/line_end for partial reads (1-based, inclusive).",
    inputSchema: toolInputSchemas.readFile,
  }),
  listDirectory: tool({
    description: "List entries in a directory under the current project directory.",
    inputSchema: toolInputSchemas.listDirectory,
  }),
  glob: tool({
    description: "Find files matching a glob pattern under the current project directory.",
    inputSchema: toolInputSchemas.glob,
  }),
  grep: tool({
    description:
      "Search file contents with a regular expression under the current project directory.",
    inputSchema: toolInputSchemas.grep,
  }),
  // HARNESS-02: structured git read — model should prefer these over bash git *.
  gitStatus: tool({
    description: "Get git repository status: branch, clean/dirty, file counts.",
    inputSchema: toolInputSchemas.gitStatus,
  }),
  gitDiff: tool({
    description:
      "Get git diff. Default: unstaged changes. Use staged or ref to narrow scope.",
    inputSchema: toolInputSchemas.gitDiff,
  }),
  task: tool({
    description:
      "Delegate work to a specialized subagent (explore or plan-research). Returns a summary only.",
    inputSchema: toolInputSchemas.task,
  }),
} as const;

/** Full toolset for BUILD mode: read-only tools plus write/edit/bash. */
export const buildToolContracts = {
  ...readOnlyToolContracts,
  writeFile: tool({
    description: "Create or overwrite a file under the current project directory.",
    inputSchema: toolInputSchemas.writeFile,
  }),
  editFile: tool({
    description: "Replace exact text in a file under the current project directory.",
    inputSchema: toolInputSchemas.editFile,
  }),
  bash: tool({
    description: "Run a shell command in the current project directory.",
    inputSchema: toolInputSchemas.bash,
  }),
} as const;

export type ToolContracts = typeof buildToolContracts;

/** Returns AI SDK tool definitions for the given mode (no executors — Phase 11 runs tools on CLI). */
export function getToolContracts(mode: ModeType) {
  return mode === Mode.PLAN 
    ? readOnlyToolContracts 
    : buildToolContracts;
};