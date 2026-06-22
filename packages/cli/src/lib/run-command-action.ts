import type { CommandContext } from "../components/command-menu/types";

/** Runs a slash-command action and forwards rejections to `onError`. */
export function runCommandAction(
  action: (ctx: CommandContext) => void | Promise<void>,
  ctx: CommandContext,
  onError: (message: string) => void,
): void {
  void Promise.resolve(action(ctx)).catch((error) => {
    onError(error instanceof Error ? error.message : "Command failed");
  });
}
