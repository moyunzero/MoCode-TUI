import {
  deserializeMcpToolsToDynamic,
  getToolContracts,
  Mode,
  type SerializedMcpTool,
} from "@mocode/shared";
import type { ToolSet } from "ai";
import { isMcpReadOnlyTool, isMcpToolName, parseMcpToolName } from "../../mcp/heuristics";
import type { SubagentToolSetOptions, SubagentType } from "./types";

const PLAN_RESEARCH_LOCAL_TOOLS = [
  "readFile",
  "listDirectory",
  "glob",
  "grep",
  "gitStatus",
  "gitDiff",
] as const;

function omitTask(tools: ToolSet): ToolSet {
  const { task: _task, ...rest } = tools as ToolSet & { task?: unknown };
  return rest;
}

function filterReadOnlyMcpTools(mcpTools: SerializedMcpTool[]): ToolSet {
  const dynamic = deserializeMcpToolsToDynamic(mcpTools);
  const filtered: ToolSet = {};

  for (const [name] of Object.entries(dynamic)) {
    if (!isMcpToolName(name)) {
      continue;
    }
    const { tool } = parseMcpToolName(name);
    if (isMcpReadOnlyTool(tool)) {
      filtered[name] = dynamic[name]!;
    }
  }

  return filtered;
}

function pickLocalTools(names: readonly string[]): ToolSet {
  const planTools = getToolContracts(Mode.PLAN) as ToolSet;
  const picked: ToolSet = {};
  for (const name of names) {
    if (planTools[name]) {
      picked[name] = planTools[name]!;
    }
  }
  return picked;
}

/**
 * Builds schema-only tool set for a subagent type (D-05, D-14, D-15).
 * Execution wrappers are added in runner.ts.
 */
export function buildSubagentToolSet(
  type: SubagentType,
  options: SubagentToolSetOptions = {},
): ToolSet {
  const mcpTools = options.mcpTools ?? [];

  if (type === "plan-research") {
    return pickLocalTools(PLAN_RESEARCH_LOCAL_TOOLS);
  }

  return {
    ...omitTask(getToolContracts(Mode.PLAN) as ToolSet),
    ...filterReadOnlyMcpTools(mcpTools),
  };
}
