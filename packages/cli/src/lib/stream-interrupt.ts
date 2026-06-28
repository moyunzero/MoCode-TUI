import type { UIMessage } from "ai";
import {
  findSupportedChatModel,
  hasVisibleAssistantContent,
  type ModeType,
  type SupportedChatModelId,
} from "@mocode/shared";
import { stripIncompleteAssistantMessages as stripFromTransport } from "./local-chat-transport";

export const INTERRUPTED_TOOL_ERROR_TEXT = "Interrupted by user";

export type ResumeEligibility = "user-only" | "partial-assistant" | "none";
export type ChatStatus = "ready" | "streaming" | "submitted" | "error";
export type ResumeTransportAction = "regenerate" | "none";

type ToolPart = {
  type: string;
  state?: string;
  errorText?: string;
};

function isPendingToolPart(part: ToolPart): boolean {
  if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
    const state = part.state;
    return state !== "output-available" && state !== "output-error";
  }
  return false;
}

/** Pending tool call ids on the last assistant message (for Esc during local tool exec). */
export function collectPendingToolCallIds(messages: UIMessage[]): string[] {
  const lastIndex = messages.findLastIndex((message) => message.role === "assistant");
  if (lastIndex === -1) return [];

  const parts = messages[lastIndex]?.parts;
  if (!Array.isArray(parts)) return [];

  const ids: string[] = [];
  for (const part of parts) {
    const toolPart = part as ToolPart & { toolCallId?: string };
    if (!isPendingToolPart(toolPart)) continue;
    if (typeof toolPart.toolCallId === "string") ids.push(toolPart.toolCallId);
  }
  return ids;
}

function finalizeAssistantParts(parts: unknown[]): unknown[] {
  return parts.map((part) => {
    const toolPart = part as ToolPart;
    if (!isPendingToolPart(toolPart)) return part;
    return {
      ...toolPart,
      state: "output-error",
      errorText: INTERRUPTED_TOOL_ERROR_TEXT,
    };
  });
}

export function finalizeInterruptedAssistant<UI_MESSAGE extends UIMessage>(
  messages: UI_MESSAGE[],
): UI_MESSAGE[] {
  const lastIndex = messages.findLastIndex((message) => message.role === "assistant");
  if (lastIndex === -1) return messages;

  const last = messages[lastIndex];
  if (last === undefined) return messages;
  if (!Array.isArray(last.parts) || last.parts.length === 0) return messages;

  const updated = {
    ...last,
    parts: finalizeAssistantParts(last.parts),
  } as UI_MESSAGE;

  return [...messages.slice(0, lastIndex), updated, ...messages.slice(lastIndex + 1)];
}

export function normalizeInterruptedMessages<UI_MESSAGE extends UIMessage>(
  messages: UI_MESSAGE[],
): UI_MESSAGE[] {
  return stripIncompleteAssistantMessages(finalizeInterruptedAssistant(messages));
}

export function stripIncompleteAssistantMessages<UI_MESSAGE extends UIMessage>(
  messages: UI_MESSAGE[],
): UI_MESSAGE[] {
  return stripFromTransport(messages);
}

export function detectResumeEligibility(
  messages: UIMessage[],
  chatStatus: ChatStatus,
): ResumeEligibility {
  if (chatStatus === "streaming" || chatStatus === "submitted") return "none";
  if (messages.length === 0) return "none";

  const last = messages.at(-1);
  if (!last) return "none";
  if (last.role === "user") return "user-only";
  if (last.role === "assistant" && hasVisibleAssistantContent(last)) {
    return "partial-assistant";
  }
  return "none";
}

export function resolveResumeTransport(eligibility: ResumeEligibility): ResumeTransportAction {
  if (eligibility === "user-only") return "regenerate";
  // /resume on partial assistant: drop failed reply and regenerate from last user (D-11 UX).
  if (eligibility === "partial-assistant") return "regenerate";
  return "none";
}

export function shouldAutoResumeOnMount(params: {
  eligibility: ResumeEligibility;
  hasAutoResumed: boolean;
  initialPromptPending: boolean;
}): boolean {
  if (params.hasAutoResumed || params.initialPromptPending) return false;
  return params.eligibility === "user-only";
}

/** Skip late tool output after Esc marked this tool call id. */
export function shouldSkipInterruptedToolOutput(
  toolCallId: string,
  skipIds: ReadonlySet<string>,
): boolean {
  return skipIds.has(toolCallId);
}

/** Trim transcript for /resume — only the last user message gets new mode/model metadata. */
export function trimMessagesForRegenerate<UI_MESSAGE extends UIMessage>(
  messages: UI_MESSAGE[],
  params: { mode: ModeType; model: SupportedChatModelId },
): UI_MESSAGE[] | null {
  const lastUser = messages.findLast((message) => message.role === "user");
  if (!lastUser) return null;

  const userIndex = messages.findIndex((message) => message.id === lastUser.id);
  const trimmed = messages.slice(0, userIndex + 1);
  const priorMetadata =
    lastUser.metadata && typeof lastUser.metadata === "object"
      ? (lastUser.metadata as Record<string, unknown>)
      : {};
  trimmed[trimmed.length - 1] = {
    ...lastUser,
    metadata: {
      ...priorMetadata,
      mode: params.mode,
      model: params.model,
    },
  } as UI_MESSAGE;
  return trimmed;
}

function resolveStoredModel(
  stored: unknown,
  fallback: SupportedChatModelId,
): SupportedChatModelId {
  if (typeof stored === "string" && findSupportedChatModel(stored) != null) {
    return stored as SupportedChatModelId;
  }
  return fallback;
}

/** Derive auto-resume params from normalized chat state (not raw initialMessages). */
export function resolveAutoResumeRequest(params: {
  messages: UIMessage[];
  status: ChatStatus;
  hasAutoResumed: boolean;
  initialPromptPending: boolean;
  fallbackMode: ModeType;
  fallbackModel: SupportedChatModelId;
}): { mode: ModeType; model: SupportedChatModelId } | null {
  const normalized = stripIncompleteAssistantMessages(params.messages);
  const eligibility = detectResumeEligibility(normalized, params.status);
  const shouldAuto = shouldAutoResumeOnMount({
    eligibility,
    hasAutoResumed: params.hasAutoResumed,
    initialPromptPending: params.initialPromptPending,
  });
  if (!shouldAuto) return null;

  const lastUser = normalized.findLast((message) => message.role === "user");
  const lastUserMetadata = lastUser?.metadata as { mode?: ModeType; model?: unknown } | undefined;
  return {
    mode: lastUserMetadata?.mode ?? params.fallbackMode,
    model: resolveStoredModel(lastUserMetadata?.model, params.fallbackModel),
  };
}
