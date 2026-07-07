import { Mode, type ModeType } from "@mocode/shared";
import type { LanguageModelUsage } from "ai";

export function shouldShowGeneratingInFooter(params: {
  streaming: boolean;
  hasTextPart: boolean;
  toolsPending: boolean;
}): boolean {
  return params.streaming && !params.hasTextPart && !params.toolsPending;
}

export function shouldShowDurationInFooter(params: {
  streaming: boolean;
  durationMs?: number;
}): boolean {
  if (params.streaming) return false;
  return params.durationMs != null && params.durationMs > 0;
}

/** Task-only assistant rows use the tool block frame — skip the generic ◉ footer. */
export function shouldShowAssistantMessageFooter(
  parts: Array<{ type: string }>,
): boolean {
  const meaningful = parts.filter((part) => part.type !== "step-start");
  if (meaningful.length === 0) return false;
  return meaningful.some((part) => part.type === "text" || part.type === "reasoning");
}

function formatDuration(durationMs: number): string {
  const seconds = durationMs / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds)}s`;
}

export function formatAssistantFooter(params: {
  mode: ModeType;
  model: string;
  durationMs?: number;
  streaming: boolean;
  usage?: LanguageModelUsage;
}): string {
  const parts: string[] = [];
  parts.push(params.mode === Mode.PLAN ? "Plan" : "Build");
  parts.push(params.model);

  if (shouldShowDurationInFooter(params)) {
    parts.push(formatDuration(params.durationMs!));
  }

  if (!params.streaming && params.usage?.inputTokens != null) {
    parts.push(`↑${params.usage.inputTokens}`);
  }
  if (!params.streaming && params.usage?.outputTokens != null) {
    parts.push(`↓${params.usage.outputTokens}`);
  }

  return parts.join(" · ");
}
