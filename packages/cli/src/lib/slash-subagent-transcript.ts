import type { ModeType, SupportedChatModelId } from "@mocode/shared";

export type SlashSubagentType = "explore" | "plan-research";

export type SlashTaskInput = {
  subagent_type: SlashSubagentType;
  prompt: string;
  description: string;
};

export type SlashTranscriptMessage = {
  id: string;
  role: "user" | "assistant";
  parts: Array<Record<string, unknown>>;
  metadata?: { mode: ModeType; model: SupportedChatModelId };
};

export type SlashSubagentRunResult = {
  summary: string;
  error?: boolean;
  interrupted?: boolean;
};

export function buildSlashSubagentPair(params: {
  type: SlashSubagentType;
  prompt: string;
  slashLine: string;
  mode: ModeType;
  model: SupportedChatModelId;
  now?: number;
}): { user: SlashTranscriptMessage; assistant: SlashTranscriptMessage; toolCallId: string } {
  const now = params.now ?? Date.now();
  const toolCallId = `slash-task-${now}`;
  const taskInput: SlashTaskInput = {
    subagent_type: params.type,
    prompt: params.prompt,
    description: params.prompt,
  };

  return {
    toolCallId,
    user: {
      id: `user-slash-${now}`,
      role: "user",
      parts: [{ type: "text", text: params.slashLine }],
      metadata: { mode: params.mode, model: params.model },
    },
    assistant: {
      id: `assistant-slash-${now}`,
      role: "assistant",
      parts: [
        {
          type: "tool-task",
          toolCallId,
          state: "input-available",
          input: taskInput,
        },
      ],
      metadata: { mode: params.mode, model: params.model },
    },
  };
}

const BLANK_SUBAGENT_SUMMARY = "Subagent finished without a text summary.";

export function normalizeSubagentSummary(
  summary: string,
  _result: SlashSubagentRunResult,
): string {
  const trimmed = summary.trim();
  if (trimmed.length > 0) return trimmed;
  return BLANK_SUBAGENT_SUMMARY;
}

export function finalizeSlashSubagentAssistant(
  assistant: SlashTranscriptMessage,
  toolCallId: string,
  taskInput: SlashTaskInput,
  result: SlashSubagentRunResult,
): SlashTranscriptMessage {
  const summary = normalizeSubagentSummary(result.summary, result);
  const part =
    result.error || result.interrupted
      ? {
          type: "tool-task",
          toolCallId,
          state: "output-error",
          input: taskInput,
          errorText: summary,
        }
      : {
          type: "tool-task",
          toolCallId,
          state: "output-available",
          input: taskInput,
          output: { summary },
        };

  return { ...assistant, parts: [part] };
}

/** Hide generic streaming placeholder while slash subagent or pending Task row is active. */
export function shouldShowPendingTranscriptReply(params: {
  isLoading: boolean;
  lastMessageRole?: string;
  subagentRunning: boolean;
  hasPendingTaskInTranscript: boolean;
}): boolean {
  if (params.subagentRunning || params.hasPendingTaskInTranscript) return false;
  return params.isLoading && params.lastMessageRole === "user";
}

export function transcriptHasPendingTask(
  messages: Array<{ role: string; parts?: Array<{ type?: string; state?: string }> }>,
): boolean {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || !Array.isArray(last.parts)) return false;

  return last.parts.some(
    (part) =>
      part.type === "tool-task" &&
      part.state !== "output-available" &&
      part.state !== "output-error",
  );
}
