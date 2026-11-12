/**
 * Explicit agent-loop controller.
 *
 * Before this module, MoCode's multi-step loop was implicit: the AI SDK's
 * `sendAutomaticallyWhen` re-posted whenever the last assistant message had no
 * pending tool calls. That produces a working loop but leaves three questions a
 * production agent must be able to answer unanswered:
 *
 *   1. How much work may one user message spend?   → turn + per-turn tool budgets
 *   2. When is the agent stuck rather than working? → consecutive-repeat guard
 *   3. Why did it stop?                             → named stop reasons
 *
 * One *turn* is one model response plus the tool calls it requested. The first
 * response after a user message is turn 1. {@link AgentLoop.beginTurn} runs when
 * the loop decides to continue, so `maxTurns` bounds *continued* turns: with
 * `maxTurns: 24` a single user message can produce at most 25 model responses.
 *
 * Pure module: no React, no network, no filesystem — unit-testable in isolation.
 */

/** Why the loop stopped. Every exit is named so the TUI can explain it. */
export type AgentStopReason =
  | "max-turns"
  | "max-tool-calls"
  | "no-progress"
  | "aborted"
  | "error";

/** Budgets for one user message. */
export type AgentLoopLimits = {
  /** Model responses the loop may continue to. */
  maxTurns: number;
  /** Tool calls allowed inside a single turn. */
  maxToolCallsPerTurn: number;
  /** Identical consecutive tool calls tolerated before declaring no progress. */
  maxConsecutiveRepeats: number;
};

export const DEFAULT_AGENT_LIMITS: AgentLoopLimits = {
  maxTurns: 24,
  maxToolCallsPerTurn: 16,
  maxConsecutiveRepeats: 3,
};

export type AgentLoopDecision =
  | { action: "continue" }
  | { action: "stop"; reason: AgentStopReason; detail: string };

export type AgentLoopSnapshot = {
  turn: number;
  maxTurns: number;
  toolCallsThisTurn: number;
  totalToolCalls: number;
  stopReason: AgentStopReason | null;
};

/** Reactive subset rendered by the status line ({components.status-bar} in DESIGN.md). */
export type AgentProgress = Pick<
  AgentLoopSnapshot,
  "turn" | "maxTurns" | "toolCallsThisTurn"
>;

/**
 * Status-line label for the loop budget, or `null` when no run has started.
 * One dim segment: `turn 3/24`, plus `· 4 tools` when the turn has run tools.
 */
export function formatAgentProgress(progress: AgentProgress | null): string | null {
  if (!progress || progress.turn <= 0) return null;

  // `turn` counts *continuations*: the first response is already spent by the time
  // the loop decides to continue, and `maxTurns` bounds continuations. Showing the
  // raw counter labelled "turn" under-reported both the spend and the budget.
  const responses = progress.turn + 1;
  const budget = progress.maxTurns + 1;
  const base = `turn ${responses}/${budget}`;
  if (progress.toolCallsThisTurn <= 0) return base;
  const label = progress.toolCallsThisTurn === 1 ? "tool" : "tools";
  return `${base} · ${progress.toolCallsThisTurn} ${label}`;
}

/**
 * Stable serialization used for tool-call signatures. Key order in model-emitted
 * JSON is not stable, so a plain `JSON.stringify` would miss true repeats.
 */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableKey(v)}`);

  return `{${entries.join(",")}}`;
}

/** Signature of one tool call: same tool + same normalized input. */
export function toolSignature(toolName: string, input: unknown): string {
  return `${toolName}:${stableKey(input)}`;
}

export class AgentLoop {
  private readonly limits: AgentLoopLimits;
  private turn = 0;
  private toolCallsThisTurn = 0;
  private totalToolCalls = 0;
  private stopReason: AgentStopReason | null = null;
  private stopDetail = "";
  private userMessageId: string | null = null;
  private lastSignature: string | null = null;
  private consecutiveRepeats = 0;

  constructor(limits: Partial<AgentLoopLimits> = {}) {
    this.limits = { ...DEFAULT_AGENT_LIMITS, ...limits };
  }

  /**
   * Start (or continue) the loop for a user message. A different id starts a
   * fresh budget; the same id keeps the current one, so regenerating a reply does
   * not silently hand the model an extra 24 turns.
   */
  beginUserMessage(messageId: string): void {
    if (this.userMessageId === messageId) return;
    this.userMessageId = messageId;
    this.reset();
  }

  /** Clear budgets and stop state, keeping the current user message id. */
  reset(): void {
    this.turn = 0;
    this.toolCallsThisTurn = 0;
    this.totalToolCalls = 0;
    this.stopReason = null;
    this.stopDetail = "";
    this.lastSignature = null;
    this.consecutiveRepeats = 0;
  }

  /** Ask permission to start the next model turn. */
  beginTurn(): AgentLoopDecision {
    const stopped = this.stoppedDecision();
    if (stopped) return stopped;

    if (this.turn >= this.limits.maxTurns) {
      return this.fail(
        "max-turns",
        `Stopped after ${this.limits.maxTurns} turns without a final answer.`,
      );
    }

    this.turn += 1;
    this.toolCallsThisTurn = 0;
    return { action: "continue" };
  }

  /** Account for one tool call before it executes. */
  recordToolCall(toolName: string, input: unknown): AgentLoopDecision {
    const stopped = this.stoppedDecision();
    if (stopped) return stopped;

    if (this.toolCallsThisTurn >= this.limits.maxToolCallsPerTurn) {
      return this.fail(
        "max-tool-calls",
        `Stopped after ${this.limits.maxToolCallsPerTurn} tool calls in one turn.`,
      );
    }

    this.toolCallsThisTurn += 1;
    this.totalToolCalls += 1;

    const signature = toolSignature(toolName, input);
    // Only *consecutive* identical calls count. read → edit → read is normal
    // work; read → read → read → read with identical input is a loop.
    this.consecutiveRepeats = signature === this.lastSignature ? this.consecutiveRepeats + 1 : 1;
    this.lastSignature = signature;

    if (this.consecutiveRepeats > this.limits.maxConsecutiveRepeats) {
      return this.fail(
        "no-progress",
        `Stopped: ${toolName} was called ${this.consecutiveRepeats} times in a row with identical input.`,
      );
    }

    return { action: "continue" };
  }

  /** Escape hatch for user interruption (Esc). */
  abort(): void {
    this.fail("aborted", "Stopped by user.");
  }

  /** Escape hatch for a transport or tool failure that ends the run. */
  failWith(reason: AgentStopReason, detail: string): AgentLoopDecision {
    return this.fail(reason, detail);
  }

  get stopped(): AgentStopReason | null {
    return this.stopReason;
  }

  snapshot(): AgentLoopSnapshot {
    return {
      turn: this.turn,
      maxTurns: this.limits.maxTurns,
      toolCallsThisTurn: this.toolCallsThisTurn,
      totalToolCalls: this.totalToolCalls,
      stopReason: this.stopReason,
    };
  }

  private fail(reason: AgentStopReason, detail: string): AgentLoopDecision {
    // Sticky: once stopped, every later decision repeats the same reason.
    if (this.stopReason === null) {
      this.stopReason = reason;
      this.stopDetail = detail;
    }

    return { action: "stop", reason: this.stopReason, detail: this.stopDetail };
  }

  private stoppedDecision(): AgentLoopDecision | null {
    if (this.stopReason === null) return null;
    return { action: "stop", reason: this.stopReason, detail: this.stopDetail };
  }
}
