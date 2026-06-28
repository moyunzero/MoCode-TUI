/**
 * chokidar hot-reload for mcp.json changes (Phase 02, D-04).
 *
 * Watches both global and project config paths; debounces 300ms then disconnectAll +
 * connectAll so rapid saves coalesce. Module-level debounce state assumes one active
 * session watcher per process (session unmount calls stopMcpWatcher).
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { getMcpConfigPaths } from "./config";
import { getMcpManager, type McpManager } from "./manager";

const DEBOUNCE_MS = 300;

export type McpWatcherDeps = {
  watch?: typeof chokidar.watch;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  exists?: typeof existsSync;
  getManager?: () => McpManager;
  getPaths?: typeof getMcpConfigPaths;
};

type ActiveWatcher = {
  handle: FSWatcher;
};

let activeWatchers: ActiveWatcher[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let debounceCwd: string | undefined;
let debounceOnReload: (() => void) | undefined;
let timerHooks: Pick<McpWatcherDeps, "setTimer" | "clearTimer"> = {};

function resolveDeps(deps?: McpWatcherDeps): Required<McpWatcherDeps> {
  return {
    watch: deps?.watch ?? chokidar.watch.bind(chokidar),
    setTimer: deps?.setTimer ?? setTimeout,
    clearTimer: deps?.clearTimer ?? clearTimeout,
    exists: deps?.exists ?? existsSync,
    getManager: deps?.getManager ?? getMcpManager,
    getPaths: deps?.getPaths ?? getMcpConfigPaths,
  };
}

function resolveWatchTarget(path: string, exists: typeof existsSync): string {
  return exists(path) ? path : dirname(path);
}

async function reloadMcp(
  cwd: string,
  onReload: (() => void) | undefined,
  getManager: () => McpManager,
): Promise<void> {
  const manager = getManager();
  await manager.disconnectAll();
  await manager.connectAll(cwd);
  onReload?.();
}

function scheduleReload(cwd: string, onReload: (() => void) | undefined, deps: Required<McpWatcherDeps>): void {
  debounceCwd = cwd;
  debounceOnReload = onReload;

  if (debounceTimer !== undefined) {
    deps.clearTimer(debounceTimer);
  }

  debounceTimer = deps.setTimer(() => {
    debounceTimer = undefined;
    const targetCwd = debounceCwd ?? cwd;
    const callback = debounceOnReload;
    debounceCwd = undefined;
    debounceOnReload = undefined;
    void reloadMcp(targetCwd, callback, deps.getManager).catch((error) => {
      console.error("MCP config reload failed:", error);
    });
  }, DEBOUNCE_MS);
}

/** Watches global and project mcp.json; debounced reload reconnects all MCP servers. */
export function watchMcpConfig(cwd: string, onReload?: () => void, deps?: McpWatcherDeps): void {
  const resolved = resolveDeps(deps);
  timerHooks = { setTimer: resolved.setTimer, clearTimer: resolved.clearTimer };

  stopMcpWatcher(resolved);

  const paths = resolved.getPaths(cwd);
  for (const configPath of [paths.global, paths.project]) {
    const target = resolveWatchTarget(configPath, resolved.exists);
    const handle = resolved.watch(target, { ignoreInitial: true });

    const onConfigEvent = (changedPath: string) => {
      if (changedPath !== configPath) {
        return;
      }
      scheduleReload(cwd, onReload, resolved);
    };

    handle.on("change", onConfigEvent);
    handle.on("add", onConfigEvent);
    handle.on("unlink", onConfigEvent);
    activeWatchers.push({ handle });
  }
}

/** Stops all MCP config watchers and clears pending debounced reloads. */
export function stopMcpWatcher(deps?: Pick<McpWatcherDeps, "clearTimer">): void {
  const clearTimer = deps?.clearTimer ?? timerHooks.clearTimer ?? clearTimeout;

  if (debounceTimer !== undefined) {
    clearTimer(debounceTimer);
    debounceTimer = undefined;
  }

  debounceCwd = undefined;
  debounceOnReload = undefined;

  for (const { handle } of activeWatchers) {
    void handle.close();
  }
  activeWatchers = [];
}
