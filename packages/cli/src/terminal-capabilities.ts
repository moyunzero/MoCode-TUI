/** Whether the terminal can report Shift+Enter (Kitty / modifyOtherKeys / CSI u). */
export function terminalSupportsShiftEnter(): boolean {
  const program = process.env.TERM_PROGRAM ?? "";
  // Apple Terminal emits bare \r; the shift bit is never set.
  if (program === "Apple_Terminal") return false;
  // VS Code / Cursor integrated terminals need custom keybindings; unreliable by default.
  if (program === "vscode") return false;
  return true;
}

export function isAppleTerminal(): boolean {
  return process.env.TERM_PROGRAM === "Apple_Terminal";
}

export type NewlineHint = {
  submit: string;
  newline: string;
  note?: string;
};

/** Shortcut labels for the status bar, adapted to the current terminal. */
export function getNewlineHint(): NewlineHint {
  if (terminalSupportsShiftEnter()) {
    return { submit: "↵", newline: "⇧↵", note: "Ctrl+J" };
  }

  const program = process.env.TERM_PROGRAM ?? "";
  const note =
    isAppleTerminal() || program === "vscode" ? undefined : "⌥↵";

  return { submit: "↵", newline: "Ctrl+J", note };
}
