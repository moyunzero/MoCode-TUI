/**
 * What the agent is doing *right now*.
 *
 * The transcript already records what happened; this answers the question a user
 * asks while waiting: "is it thinking, or stuck?" The phase is derived from the
 * live message parts rather than tracked separately, so it can never disagree with
 * what is on screen.
 *
 * Pure module: no timers, no I/O.
 */

export type AgentPhase = "waiting" | "thinking" | "running" | "generating";

/** Minimum shape needed from a UI message — keeps this testable without the SDK. */
export type PhaseMessage = {
  parts?: unknown;
};

type PartLike = {
  type?: unknown;
  state?: unknown;
};

function partsOf(message: PhaseMessage | null | undefined): PartLike[] {
  if (!message || !Array.isArray(message.parts)) return [];
  return message.parts as PartLike[];
}

/** A tool part that has been requested but not yet resolved. */
function hasPendingTool(parts: PartLike[]): boolean {
  return parts.some((part) => {
    const type = typeof part.type === "string" ? part.type : "";
    const isTool = type === "dynamic-tool" || type.startsWith("tool-");
    if (!isTool) return false;

    const state = typeof part.state === "string" ? part.state : "";
    return state !== "output-available" && state !== "output-error";
  });
}

function hasPart(parts: PartLike[], type: string): boolean {
  return parts.some((part) => part.type === type);
}

/**
 * Whether a run is in progress.
 *
 * `chat.status` alone is not enough: the loop is client-driven, so between a model
 * step and the auto-resubmit the status is `ready` even though the agent is busy
 * executing tools. Keying "active" on the status made the phase disappear exactly
 * during tool execution — the one moment a user most wants to see it.
 */
export function isRunActive(params: {
  /** Chat status from the SDK. */
  status: string;
  /** The message being streamed or awaiting tool results. */
  message?: PhaseMessage | null;
}): boolean {
  if (params.status === "submitted" || params.status === "streaming") return true;

  return hasPendingTool(partsOf(params.message));
}

/**
 * Derive the current phase, or `null` when the agent is idle.
 *
 * Precedence is deliberate: a pending tool means the agent is *acting*, which is
 * more useful to show than the text that preceded it.
 */
export function deriveAgentPhase(params: {
  /** Chat status from the SDK. */
  status: string;
  /** The message being streamed, if any. */
  message?: PhaseMessage | null;
}): AgentPhase | null {
  if (!isRunActive(params)) return null;

  const parts = partsOf(params.message);
  if (parts.length === 0) return "waiting";

  if (hasPendingTool(parts)) return "running";

  const hasText = hasPart(parts, "text");
  const hasReasoning = hasPart(parts, "reasoning");

  if (hasReasoning && !hasText) return "thinking";
  if (hasText) return "generating";

  return "waiting";
}

/** Human label per phase. Short on purpose — it lives in a one-row status line. */
const PHASE_LABEL: Record<AgentPhase, string> = {
  waiting: "等待首字",
  thinking: "思考中",
  running: "执行中",
  generating: "生成中",
};

/** Seconds with one decimal, e.g. `2.4s`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

/**
 * Status-line segment, e.g. `执行中 2.4s`, or `null` when idle.
 *
 * `elapsedMs` is omitted from the label when unknown so the line does not show a
 * misleading `0.0s` for work that has only just started.
 */
export function formatAgentPhase(
  phase: AgentPhase | null,
  elapsedMs: number | null,
): string | null {
  if (!phase) return null;

  const label = PHASE_LABEL[phase];
  return elapsedMs === null ? label : `${label} ${formatElapsed(elapsedMs)}`;
}
