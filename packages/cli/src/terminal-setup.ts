import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

const TERMINAL_PLIST = `${homedir()}/Library/Preferences/com.apple.Terminal.plist`;

/** Enable "Use Option as Meta Key" so Option+Enter maps to meta+return (newline). */
export function setupAppleTerminal(): { ok: boolean; message: string } {
  try {
    const theme = execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", "Print :'Startup Window Settings'", TERMINAL_PLIST],
      { encoding: "utf-8" },
    ).trim();

    if (!theme) {
      return { ok: false, message: "无法读取 Terminal 启动 Profile。" };
    }

    execFileSync(
      "/usr/libexec/PlistBuddy",
      ["-c", `Set :'Window Settings':'${theme}':useOptionAsMetaKey true`, TERMINAL_PLIST],
    );

    return {
      ok: true,
      message: [
        `已为 Profile「${theme}」启用 Use Option as Meta Key。`,
        "请完全退出并重新打开 Terminal.app，之后可用 ⌥↵ 换行。",
        "Shift+↵ 在 Terminal.app 中无法由应用区分，请用 Ctrl+J 或 ⌥↵。",
      ].join("\n"),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Terminal 配置失败：${detail}\n也可手动：设置 → 描述文件 → 键盘 → 勾选「将 Option 键用作 Meta 键」。`,
    };
  }
}

/** Returns true when argv handled setup and the caller should exit without starting the TUI. */
export function runTerminalSetupFromArgv(argv: string[]): boolean {
  if (!argv.includes("--terminal-setup")) return false;

  if (!process.env.TERM_PROGRAM?.includes("Apple_Terminal")) {
    console.log("当前不是 Apple Terminal，无需此配置。Shift+↵ 或 Ctrl+J 换行。");
    return true;
  }

  const result = setupAppleTerminal();
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
