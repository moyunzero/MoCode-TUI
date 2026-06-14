import { TextAttributes } from "@opentui/core";
import { getNewlineHint } from "../terminal-capabilities";

/** Footer hints: model label plus submit/newline shortcuts for this terminal. */
export function StatusBar() {
  const hint = getNewlineHint();

  return (
    <box flexDirection="row" gap={1} flexWrap="wrap">
      <text fg="cyan">Build</text>
      <text attributes={TextAttributes.DIM} fg="gray">
        {">"}
      </text>
      <text>opus-4-6</text>
      <text attributes={TextAttributes.DIM} fg="gray">
        ·
      </text>
      <text attributes={TextAttributes.DIM} fg="gray">
        {hint.submit} 提交
      </text>
      <text attributes={TextAttributes.DIM} fg="gray">
        ·
      </text>
      <text attributes={TextAttributes.DIM} fg="gray">
        {hint.newline} 换行
      </text>
      {hint.note ? (
        <>
          <text attributes={TextAttributes.DIM} fg="gray">
            ·
          </text>
          <text attributes={TextAttributes.DIM} fg="gray">
            {hint.note}
          </text>
        </>
      ) : null}
    </box>
  );
}