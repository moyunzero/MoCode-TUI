/**
 * BYOK entry flag via `mocode --local` (D-09).
 *
 * When true: no OAuth/MoCode server chat HTTP — sessions persist under ~/.mocode/projects,
 * inference uses LocalChatTransport + keys.json provider credentials.
 */
let localMode = false;

/** Parses CLI argv for the explicit `--local` BYOK opt-in flag. */
export function parseCliArgs(argv: string[]): { local: boolean } {
  return { local: argv.includes("--local") };
}

/** Returns whether the CLI was started with `--local`. */
export function isLocalMode(): boolean {
  return localMode;
}

/** Sets module-level local mode (called from index.tsx before router boot). */
export function setLocalMode(value: boolean): void {
  localMode = value;
}
