import type { ModeType, SupportedChatModelId } from "@mocode/shared";
import type { SerializedMcpTool } from "@mocode/shared";
import type { DialogContextValue } from "../../providers/dialog";
import type { McpManager } from "../../mcp/manager";

export type SubagentType = "explore" | "plan-research";

export type SubagentToolSetOptions = {
  mcpTools?: SerializedMcpTool[];
};

export type RunSubagentParams = {
  subagent_type: SubagentType;
  prompt: string;
  mode: ModeType;
  abortSignal?: AbortSignal;
  model?: SupportedChatModelId | string;
  sessionId?: string;
  description?: string;
};

export type RunSubagentResult = {
  summary: string;
  interrupted?: boolean;
  error?: boolean;
};

export type RunSubagentDeps = {
  getMcpManager?: () => McpManager;
  dialog?: DialogContextValue;
  cwd?: string;
};

export type ExecuteTaskToolParams = {
  input: unknown;
  mode: ModeType;
  model?: SupportedChatModelId | string;
  sessionId?: string;
  abortSignal?: AbortSignal;
  deps?: RunSubagentDeps;
};
