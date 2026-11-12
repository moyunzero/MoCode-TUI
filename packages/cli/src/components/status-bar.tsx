import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { getNewlineHint, type NewlineHint } from "../terminal-capabilities";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode } from "@mocode/shared";
import { formatAgentProgress, type AgentProgress } from "../lib/agent-loop";
import { formatAgentPhase, type AgentPhase } from "../lib/agent-phase";
import { Spinner } from "./spinner";

type Props = {
  subagentRunning?: boolean;
  subagentType?: string | null;
  /** Loop budget for the current user message; see `lib/agent-loop.ts`. */
  agentProgress?: AgentProgress | null;
  /** Set when a fallback model answered — shown in `{color.error}`, never hidden. */
  agentDowngrade?: { from: string; to: string } | null;
  /** Live phase of the running turn, e.g. `执行中`. */
  agentPhase?: AgentPhase | null;
  /** Live elapsed time for the run, in ms. */
  agentElapsedMs?: number | null;
};

/** Horizontal space the shell + composer insets take from the status row. */
const STATUS_ROW_INSET = 4;

/** Trim a label to `max` cells, marking the cut with an ellipsis. */
function truncateToWidth(text: string, max: number): string {
  if (cellWidth(text) <= max) return text;
  if (max <= 1) return "…";

  let out = "";
  let used = 0;
  for (const char of text) {
    const w = char.codePointAt(0)! > 0xff ? 2 : 1;
    if (used + w > max - 1) break;
    out += char;
    used += w;
  }

  return `${out}…`;
}

/** Visible width of a status segment in character cells (CJK ≈ 2 cells). */
function cellWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += char.codePointAt(0)! > 0xff ? 2 : 1;
  }
  return width;
}

type HintVisibility = {
  showSubmit: boolean;
  showNewline: boolean;
  showNote: boolean;
};

/**
 * Drop hints right-to-left under width pressure (DESIGN.md): note → newline → submit.
 * Mode / model / downgrade / budget are never dropped.
 */
export function selectStatusHints(
  availableCols: number,
  fixedCols: number,
  hint: NewlineHint,
): HintVisibility {
  // Each hint is rendered as `·` + label with gap={1} before both nodes.
  const hintCols = (label: string) => 1 + cellWidth("·") + 1 + cellWidth(label);
  const submitCols = hintCols(`${hint.submit} 提交`);
  const newlineCols = hintCols(`${hint.newline} 换行`);
  const noteCols = hint.note ? hintCols(hint.note) : 0;
  const budget = Math.max(0, availableCols - fixedCols);

  if (submitCols + newlineCols + noteCols <= budget) {
    return { showSubmit: true, showNewline: true, showNote: Boolean(hint.note) };
  }
  // Drop note first (rightmost), then newline, then submit.
  if (submitCols + newlineCols <= budget) {
    return { showSubmit: true, showNewline: true, showNote: false };
  }
  if (submitCols <= budget) {
    return { showSubmit: true, showNewline: false, showNote: false };
  }
  return { showSubmit: false, showNewline: false, showNote: false };
}

/** Footer hints: agent mode, model label, loop budget, and submit/newline shortcuts for this terminal. */
export function StatusBar({
  subagentRunning = false,
  subagentType = null,
  agentProgress = null,
  agentDowngrade = null,
  agentPhase = null,
  agentElapsedMs = null,
}: Props) {
  const hint = getNewlineHint();
  const { colors } = useTheme();
  const { mode, model } = usePromptConfig();
  const { width } = useTerminalDimensions();
  const budgetLabel = formatAgentProgress(agentProgress);
  const phaseLabel = formatAgentPhase(agentPhase, agentElapsedMs);

  if (subagentRunning && subagentType) {
    return (
      <box flexDirection="row" gap={1} flexWrap="no-wrap" alignItems="center">
        <Spinner mode={mode} />
        <text attributes={TextAttributes.DIM}>{subagentType}</text>
        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
          ·
        </text>
        <text>esc to interrupt</text>
      </box>
    );
  }

  const modeLabel = mode === Mode.PLAN ? "Plan" : "Build";
  const downgradeLabel = agentDowngrade ? `fallback → ${agentDowngrade.to}` : null;

  // The row lives inside the shell's padding and the composer inset, so the space
  // it can actually use is narrower than the terminal. Budgeting against the raw
  // terminal width shows hints that then get clipped by `overflow="hidden"`.
  const usableWidth = Math.max(0, width - STATUS_ROW_INSET);
  let modelLabel: string = model;

  // Approximate fixed cluster width. `gap={1}` inserts one cell between each
  // sibling text node in the row below (mode, >, model, and optional pairs).
  const fixedNodes =
    3 + // mode, >, model
    (downgradeLabel ? 2 : 0) +
    (budgetLabel ? 2 : 0) +
    (phaseLabel ? 2 : 0);
  let fixedCols = cellWidth(modeLabel) + cellWidth(">") + cellWidth(model);
  if (downgradeLabel) fixedCols += cellWidth("·") + cellWidth(downgradeLabel);
  if (budgetLabel) fixedCols += cellWidth("·") + cellWidth(budgetLabel);
  if (phaseLabel) fixedCols += cellWidth("·") + cellWidth(phaseLabel);
  fixedCols += Math.max(0, fixedNodes - 1); // gaps between siblings

  // If even the fixed labels overflow, shrink the model id rather than letting the
  // rightmost segments (downgrade, budget) be clipped away silently.
  if (fixedCols > usableWidth) {
    const overflow = fixedCols - usableWidth;
    modelLabel = truncateToWidth(modelLabel, Math.max(4, cellWidth(modelLabel) - overflow));
    fixedCols = Math.max(
      0,
      cellWidth(modeLabel) + cellWidth(">") + cellWidth(modelLabel) + (downgradeLabel ? cellWidth("·") + cellWidth(downgradeLabel) : 0) + (budgetLabel ? cellWidth("·") + cellWidth(budgetLabel) : 0) + Math.max(0, fixedNodes - 1),
    );
  }

  const visibility = selectStatusHints(usableWidth, fixedCols, hint);

  return (
    <box flexDirection="row" gap={1} flexWrap="no-wrap" overflow="hidden" height={1}>
      <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>
        {modeLabel}
      </text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        {">"}
      </text>
      <text>{modelLabel}</text>
      {phaseLabel ? (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ·
          </text>
          <text attributes={TextAttributes.DIM}>{phaseLabel}</text>
        </>
      ) : null}
      {agentDowngrade ? (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ·
          </text>
          <text fg={colors.error}>{downgradeLabel}</text>
        </>
      ) : null}
      {budgetLabel ? (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ·
          </text>
          <text attributes={TextAttributes.DIM}>{budgetLabel}</text>
        </>
      ) : null}
      {visibility.showSubmit ? (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ·
          </text>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            {hint.submit} 提交
          </text>
        </>
      ) : null}
      {visibility.showNewline ? (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ·
          </text>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            {hint.newline} 换行
          </text>
        </>
      ) : null}
      {visibility.showNote && hint.note ? (
        <>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            ·
          </text>
          <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
            {hint.note}
          </text>
        </>
      ) : null}
    </box>
  );
}
