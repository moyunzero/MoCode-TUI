import {
  buildKittyKeyboardFlags,
  type CliRenderer,
  type KittyKeyboardOptions,
} from "@opentui/core";

/** xterm modifyOtherKeys level 2 — Shift+Enter → CSI 27;2;13~ */
const MODIFY_OTHER_KEYS_ON = "\x1b[>4;2m";
const MODIFY_OTHER_KEYS_OFF = "\x1b[>4;0m";

/** Same flags Claude Code / OpenTUI recommend for disambiguated modifier keys. */
export const KITTY_KEYBOARD_OPTIONS: KittyKeyboardOptions = {
  disambiguate: true,
  alternateKeys: true,
};

/** Enable enhanced keyboard protocols so Shift+Enter differs from Enter. */
export function enableTerminalKeyboardProtocols(renderer: CliRenderer): void {
  renderer.enableKittyKeyboard(buildKittyKeyboardFlags(KITTY_KEYBOARD_OPTIONS));
  process.stdout.write(MODIFY_OTHER_KEYS_ON);
}

export function disableTerminalKeyboardProtocols(): void {
  process.stdout.write(MODIFY_OTHER_KEYS_OFF);
}
