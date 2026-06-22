import { TextAttributes } from "@opentui/core";
import { getNewlineHint } from "../terminal-capabilities";
import { useTheme } from "../providers/theme";
import { usePromptConfig } from "../providers/prompt-config";
import { Mode } from "@mocode/shared";

/** Footer hints: agent mode, model label, and submit/newline shortcuts for this terminal. */
export function StatusBar() {
  const hint = getNewlineHint();
  const { colors } = useTheme();
  const { mode, model } = usePromptConfig();

  return (
    <box flexDirection="row" gap={1} flexWrap="wrap">
      {/* Mode label uses the same accent as the input border and spinner. */}
      <text fg={mode === Mode.PLAN ? colors.planMode : colors.primary}>
        {mode === Mode.PLAN ? "Plan" : "Build"}
        </text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        {">"}
      </text>
      <text>{model}</text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ·
      </text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        {hint.submit} 提交
      </text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        ·
      </text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
        {hint.newline} 换行
      </text>
      {hint.note ? (
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