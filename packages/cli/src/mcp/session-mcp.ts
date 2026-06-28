/**
 * Session-scoped MCP initialization (Phase 02, D-06 partial).
 *
 * Called when a chat session screen mounts:
 * 1. connectAll enabled servers for session cwd
 * 2. watch mcp.json for hot-reload (chokidar, D-04)
 * 3. cleanup on unmount — stop watcher, disconnectAll
 *
 * Partial connect failure is swallowed so a bad MCP server cannot block the TUI.
 */
import { getMcpManager } from "./manager";
import { stopMcpWatcher, watchMcpConfig } from "./watcher";

export type SessionMcpDeps = {
  getManager?: typeof getMcpManager;
  watchConfig?: typeof watchMcpConfig;
  stopWatcher?: typeof stopMcpWatcher;
};

/** Connects MCP servers and watches config; returns cleanup for session unmount. */
export function initMcpOnSessionMount(cwd: string, deps: SessionMcpDeps = {}): () => void {
  const getManager = deps.getManager ?? getMcpManager;
  const watchConfig = deps.watchConfig ?? watchMcpConfig;
  const stopWatcher = deps.stopWatcher ?? stopMcpWatcher;
  const manager = getManager();

  void manager.connectAll(cwd).catch(() => {
    // Partial MCP failure must not block session render.
  });

  watchConfig(cwd);

  return () => {
    stopWatcher();
    void manager.disconnectAll();
  };
}
