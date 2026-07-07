/**
 * Hook runner — spawns shell commands with JSON stdin (Phase 04, D-34–D-39).
 */
import { matchesToolName } from "./glob-match";
import type { HookEntry, HookEvent } from "./schema";

export type HookPayload = {
  toolName: string;
  input: unknown;
  sessionId?: string;
  mode?: string;
  cwd?: string;
  event: HookEvent;
};

export type BeforeHookResult = {
  allowed: boolean;
  reason?: string;
  hookId?: string;
  timedOut?: boolean;
};

const DEFAULT_TIMEOUT_MS = 30_000;

type SpawnHookResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

async function readStreamText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  return new Response(stream).text();
}

async function spawnHook(
  command: string[],
  payload: HookPayload,
  timeoutMs: number,
): Promise<SpawnHookResult> {
  const proc = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: payload.cwd,
  });

  const stdinPayload = JSON.stringify(payload);
  proc.stdin.write(stdinPayload);
  proc.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  try {
    const exitCode = await proc.exited;
    const [stdout, stderr] = await Promise.all([
      readStreamText(proc.stdout),
      readStreamText(proc.stderr),
    ]);
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
  }
}

function parseStdoutDeny(stdout: string): BeforeHookResult | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { allow?: boolean; reason?: string };
    if (parsed.allow === false) {
      return {
        allowed: false,
        reason: parsed.reason ?? "Hook denied tool execution",
      };
    }
  } catch {
    // Non-JSON stdout on exit 0 is treated as allow.
  }
  return null;
}

function blockReason(stderr: string, exitCode: number | null, timedOut: boolean): string {
  if (timedOut) {
    return "Hook timed out";
  }
  const trimmed = stderr.trim();
  if (trimmed) return trimmed;
  if (exitCode !== null && exitCode !== 0) {
    return `Hook exited with code ${exitCode}`;
  }
  return "Hook blocked tool execution";
}

/** Runs a single beforeToolCall hook; non-zero exit or JSON deny blocks the tool. */
export async function runBeforeHook(params: {
  command: string[];
  payload: HookPayload;
  timeoutMs?: number;
}): Promise<BeforeHookResult> {
  const { command, payload, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  const result = await spawnHook(command, payload, timeoutMs);

  if (result.timedOut) {
    return { allowed: false, reason: "Hook timed out", timedOut: true };
  }

  const stdoutDeny = parseStdoutDeny(result.stdout);
  if (stdoutDeny) {
    return stdoutDeny;
  }

  if (result.exitCode !== 0) {
    return {
      allowed: false,
      reason: blockReason(result.stderr, result.exitCode, false),
    };
  }

  return { allowed: true };
}

/** Runs a single afterToolCall hook; errors are logged and never affect tool output. */
export async function runAfterHook(params: {
  command: string[];
  payload: HookPayload;
  timeoutMs?: number;
}): Promise<void> {
  const { command, payload, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
  try {
    await spawnHook(command, payload, timeoutMs);
  } catch (error) {
    console.error("afterToolCall hook failed", { command, error });
  }
}

/**
 * Runs all hooks matching `event` and `toolName`.
 * beforeToolCall: stops on first block. afterToolCall: fire-and-forget, errors swallowed.
 */
export async function runMatchingHooks(
  event: HookEvent,
  toolName: string,
  payload: HookPayload,
  hooks: HookEntry[],
): Promise<BeforeHookResult | undefined> {
  const matching = hooks.filter(
    (hook) => hook.event === event && matchesToolName(toolName, hook.toolName),
  );

  if (event === "beforeToolCall") {
    for (const hook of matching) {
      const result = await runBeforeHook({
        command: hook.command,
        payload: { ...payload, event },
        timeoutMs: hook.timeoutMs,
      });
      if (!result.allowed) {
        return { ...result, hookId: hook.id };
      }
    }
    return { allowed: true };
  }

  for (const hook of matching) {
    void runAfterHook({
      command: hook.command,
      payload: { ...payload, event },
      timeoutMs: hook.timeoutMs,
    });
  }
}
