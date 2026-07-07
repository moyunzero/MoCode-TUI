import { simpleGit } from "simple-git";
import type { ModeType } from "@mocode/shared";
import type { SubagentType } from "./types";

export type SubagentPromptParams = {
  type: SubagentType;
  cwd: string;
  mode: ModeType;
  model?: string;
  gitSummary?: string;
};

/** Summarizes git branch and working tree status for subagent env injection (D-13). */
export async function getGitSummary(cwd: string): Promise<string> {
  try {
    const git = simpleGit(cwd);
    const isRepo = await git.checkIsRepo();
    if (!isRepo) {
      return "Not a git repository";
    }

    const status = await git.status();
    const branch = status.current ?? "unknown";
    const dirty = status.files.length > 0;
    const changeCount = status.files.length;
    return `branch: ${branch}; ${dirty ? `dirty (${changeCount} changed file(s))` : "clean"}`;
  } catch {
    return "Git status unavailable";
  }
}

function typeInstructions(type: SubagentType): string {
  if (type === "explore") {
    return `
You are the **Explore** subagent — fast, read-only codebase scanning.
- Use glob, grep, readFile, and read-only MCP tools to map structure and find relevant code.
- Do not edit files or run shell commands.
- Return a concise summary of findings only — no full transcripts.`;
  }

  return `
You are the **Plan-research** subagent — architecture, tradeoffs, and option comparison.
- Use read-only local tools (readFile, gitStatus, gitDiff, glob, grep) to gather evidence.
- Compare approaches, risks, and recommendations; no implementation or file writes.
- Return a concise summary of analysis only — no full transcripts.`;
}

/** Builds isolated subagent system prompt with env block and summary-only contract (D-13, D-16). */
export function buildSubagentSystemPrompt(params: SubagentPromptParams): string {
  const { type, cwd, mode, model, gitSummary = "unknown" } = params;

  return `You are a MoCode subagent running in an isolated context.

# Environment
- cwd: ${cwd}
- git: ${gitSummary}
- parent mode: ${mode}
- parent model: ${model ?? "inherit"}

${typeInstructions(type)}

# Output contract
Respond with a **summary-only** final message for the parent agent.
Do not include raw tool dumps or full file contents unless essential.
The parent will not see your internal tool transcript.`;
}
