/**
 * Phase 11 — Renders assistant message parts including tool-call progress.
 *
 * UIMessage parts may include `text`, `reasoning`, and tool parts (`tool-*` or
 * `dynamic-tool`). Tool parts stream through states: input → running (`…`) →
 * `output-available` or `output-error`. Execution happens on the CLI; this
 * component only reflects part state from the AI SDK message stream.
 */
import {
  shouldShowAssistantMessageFooter,
  shouldShowDurationInFooter,
  shouldShowGeneratingInFooter,
} from "../../lib/bot-message-footer";
import {
  extractTaskSummary,
  formatTaskSummaryLines,
  formatTaskToolDisplay,
  getHiddenTaskSummaryLineCount,
  shouldCapTaskSummary,
  TASK_SUMMARY_MAX_VISIBLE_LINES,
} from "../../lib/bot-message-task";
import { groupConsecutiveParts, partRenderKey } from "../../lib/bot-message-parts";
import type { LanguageModelUsage } from "ai";
import prettyMs from "pretty-ms";
import { useState } from "react";
import { EmptyBorder } from "../border";
import { Spinner } from "../spinner";
import { useTheme } from "../../providers/theme";
import type { Message } from "../../hooks/use-chat";
import { Mode, type ModeType } from "@mocode/shared";
import { TextAttributes } from "@opentui/core";

type ClientMessagePart = Message["parts"][number];
type ToolPart = Extract<ClientMessagePart, { type: `tool-${string}` | "dynamic-tool" }>;

type Props = {
  parts: ClientMessagePart[];
  model: string;
  mode: ModeType;
  durationMs?: number;
  usage?: LanguageModelUsage;
  streaming?: boolean;
};

/** Humanize camelCase tool names for the TUI (e.g. `readFile` → `Read file`). */
function formatToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function isToolPart(part: ClientMessagePart): part is ToolPart {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

/** Summarize tool arguments as a single dim line (paths, patterns, etc.). */
function formatToolArgs(tc: ToolPart): string {
  if (!("input" in tc) || tc.input == null) return "";
  if (typeof tc.input !== "object") return String(tc.input);
  return Object.values(tc.input).map(String).join(" ");
}

type BashToolDisplay = {
  command: string;
  description?: string;
};

/** TUI reject tool errors are long model hints — show a short label in the transcript. */
function formatToolErrorForDisplay(toolName: string, errorText: string): string {
  // BASH_REJECT_ERROR_TEXT from use-chat.ts is ~500 chars of model guidance;
  // users only need a one-line status in the message stream (Phase 01, plan 04).
  if (
    toolName === "bash" &&
    errorText.startsWith("User rejected this command in the TUI approval dialog")
  ) {
    return "— rejected in approval dialog";
  }
  return errorText.length > 160 ? `${errorText.slice(0, 160)}…` : errorText;
}

/**
 * Bash-specific transcript layout (Phase 01, D-24/D-26).
 * Primary line: command string. Secondary line (dim): optional description field
 * from the bash tool input — helps users understand intent when the command alone
 * is opaque (e.g. long piped one-liners).
 */
function formatBashToolDisplay(input: unknown): BashToolDisplay | null {
  if (input == null || typeof input !== "object") return null;

  const record = input as Record<string, unknown>;
  if (typeof record.command !== "string") return null;

  const description =
    typeof record.description === "string" && record.description.trim().length > 0
      ? record.description.trim()
      : undefined;

  return { command: record.command, description };
}

function TaskToolBlock({
  part,
  mode,
}: {
  part: ToolPart;
  mode: ModeType;
}) {
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const taskDisplay =
    "input" in part ? formatTaskToolDisplay(part.input) : null;
  const isPending =
    part.state !== "output-available" && part.state !== "output-error";
  const summary = extractTaskSummary(part);
  const summaryLines = summary != null ? formatTaskSummaryLines(summary) : [];
  const capped = shouldCapTaskSummary(summaryLines);
  const visibleLines =
    capped && !expanded
      ? summaryLines.slice(0, TASK_SUMMARY_MAX_VISIBLE_LINES)
      : summaryLines;
  const hiddenCount = getHiddenTaskSummaryLineCount(summaryLines);
  const isError = part.state === "output-error";

  return (
    <box
      border={["left"]}
      borderColor={colors.thinkingBorder}
      customBorderChars={{
        ...EmptyBorder,
        vertical: "│",
      }}
      width="100%"
      paddingX={2}
      gap={1}
    >
      <box flexDirection="row" alignItems="center" gap={1} width="100%">
        <text attributes={TextAttributes.DIM}>
          <em fg={colors.info}>Task:</em> {taskDisplay?.primaryText ?? formatToolArgs(part)}
        </text>
        {isPending ? <Spinner mode={mode} /> : null}
      </box>
      {taskDisplay?.showSecondarySubagentType ? (
        <text attributes={TextAttributes.DIM}> {taskDisplay.subagentType}</text>
      ) : null}
      {summary != null ? (
        <box width="100%" gap={1}>
          {visibleLines.map((line) => (
            <text
              key={`${part.toolCallId}-summary-${line}`}
              fg={isError ? colors.error : undefined}
            >
              {line}
            </text>
          ))}
          {capped ? (
            <text
              attributes={TextAttributes.DIM}
              onMouseDown={() => {
                setExpanded((value) => !value);
              }}
            >
              {expanded
                ? "… click to collapse"
                : `… +${hiddenCount} lines — click to expand`}
            </text>
          ) : null}
        </box>
      ) : null}
    </box>
  );
}

export function BotMessage({
  parts,
  model,
  mode,
  durationMs,
  usage,
  streaming = false,
}: Props) {
  const { colors } = useTheme();
  const hasTextPart = parts.some((part) => part.type === "text" && part.text.length > 0);
  const toolsPending = parts.some(
    (part) =>
      isToolPart(part) &&
      part.state !== "output-available" &&
      part.state !== "output-error",
  );
  const showGenerating = shouldShowGeneratingInFooter({
    streaming,
    hasTextPart,
    toolsPending,
  });
  const showDuration = shouldShowDurationInFooter({ streaming, durationMs });
  const showMessageFooter = shouldShowAssistantMessageFooter(parts);

  return (
    <box width="100%" alignItems="center">
      {groupConsecutiveParts(parts).map((group, i) => (
        <box key={group.key} width="100%" paddingTop={i === 0 ? 0 : 1}>
          {group.parts.map((part, partIndex) => {
            if (part.type === "reasoning") {
              return (
                <box
                  key={partRenderKey(group.key, "reasoning", partIndex)}
                  border={["left"]}
                  borderColor={colors.thinkingBorder}
                  customBorderChars={{
                    ...EmptyBorder,
                    vertical: "│",
                  }}
                  width="100%"
                  paddingX={2}
                >
                  <text attributes={TextAttributes.DIM}>
                    <em fg={colors.thinking}>Thinking:</em> {part.text}
                  </text>
                </box>
              );
            }

            if (isToolPart(part)) {
              const toolName =
                part.type === "dynamic-tool" ? part.toolName : part.type.slice("tool-".length);

              if (toolName === "task") {
                return (
                  <TaskToolBlock
                    key={part.toolCallId}
                    part={part}
                    mode={mode}
                  />
                );
              }

              const bashDisplay =
                toolName === "bash" && "input" in part
                  ? formatBashToolDisplay(part.input)
                  : null;
              const argsText = bashDisplay?.command ?? formatToolArgs(part);
              const statusSuffix =
                part.state !== "output-available" && part.state !== "output-error"
                  ? " …"
                  : "";
              const errorSuffix =
                part.state === "output-error" && part.errorText
                  ? ` ${formatToolErrorForDisplay(toolName, part.errorText)}`
                  : "";

              return (
                <box
                  key={part.toolCallId}
                  border={["left"]}
                  borderColor={colors.thinkingBorder}
                  customBorderChars={{
                    ...EmptyBorder,
                    vertical: "│",
                  }}
                  width="100%"
                  paddingX={2}
                >
                  <text attributes={TextAttributes.DIM}>
                    <em fg={colors.info}>{formatToolName(toolName)}:</em> {argsText}
                    {statusSuffix}
                    {errorSuffix}
                  </text>
                  {bashDisplay?.description ? (
                    <text attributes={TextAttributes.DIM}> {bashDisplay.description}</text>
                  ) : null}
                </box>
              );
            }

            if (part.type === "text") {
              return (
                <box key={partRenderKey(group.key, "text", partIndex)} paddingX={3} width="100%">
                  <text>{part.text}</text>
                </box>
              );
            }

            return null;
          })}
        </box>
      ))}

      {showMessageFooter ? (
      <box paddingX={3} paddingY={1} gap={1} width="100%">
        <box flexDirection="row" gap={2}>
          <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>◉</text>
          <box flexDirection="row" gap={1}>
            <text>
              {mode === Mode.PLAN ? "Plan" : "Build"}
            </text>
            <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
              ›
            </text>
            <text attributes={TextAttributes.DIM}>{model}</text>
            {showGenerating && (
              <>
                <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                  ›
                </text>
                <text attributes={TextAttributes.DIM}>Generating response…</text>
              </>
            )}
            {showDuration && (
              <>
                <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                  ›
                </text>
                <text attributes={TextAttributes.DIM}>
                  {prettyMs(durationMs!)}
                </text>
              </>
            )}
            {!streaming && usage?.inputTokens != null && (
              <>
                <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                  ›
                </text>
                <text attributes={TextAttributes.DIM}>↑{usage.inputTokens}</text>
              </>
            )}
            {!streaming && usage?.outputTokens != null && (
              <>
                <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                  ›
                </text>
                <text attributes={TextAttributes.DIM}>↓{usage.outputTokens}</text>
              </>
            )}
          </box>
        </box>
      </box>
      ) : null}
    </box>
  );
}
