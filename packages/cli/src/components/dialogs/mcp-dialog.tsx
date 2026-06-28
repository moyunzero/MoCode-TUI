/**
 * `/mcp` runtime management dialog (Phase 02, D-03).
 *
 * Lists merged global + project servers with live status from McpManager.
 * - Enter — manual reconnect (resets backoff, retries once)
 * - t — toggle enabled (persists to mcp.json, calls applyServerEnabledChange)
 *
 * Per-server `busyServersRef` prevents duplicate reconnect/toggle while npx stdio
 * cold-starts can take several seconds. Pending HTTP/SSE servers poll every 1s.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { getMcpConfigPaths, setServerEnabled } from "../../mcp/config";
import { getMcpManager, type McpServerStatus } from "../../mcp/manager";
import { moveDialogSelection } from "../../lib/dialog-action-nav";
import { truncatePathForDisplay } from "../../lib/truncate-path";
import { McpConnectionStatus } from "../../mcp/types";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { useToast } from "../../providers/toast";
import { scrollIndexIntoView, visibleItemCount } from "../../utils/list-scroll-nav";

const MCP_ROW_HEIGHT = 2;
const MCP_LIST_MAX_ITEMS = 6;
const DIALOG_PADDING_X = 4;
const DIALOG_MAX_WIDTH = 72;

function formatStatusRow(
  server: McpServerStatus,
  maxWidth: number,
  options?: { busy?: boolean },
): string {
  let row: string;
  if (options?.busy) {
    row = `${server.transport} · reconnecting…`;
  } else if (!server.enabled) {
    row = `${server.transport} · disabled`;
  } else if (server.status === McpConnectionStatus.CONNECTED) {
    const toolSuffix =
      server.toolCount === undefined
        ? ""
        : server.toolCount === 0
          ? " · no tools"
          : ` · ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`;
    row = `${server.transport} · connected${toolSuffix}`;
  } else if (server.status === McpConnectionStatus.PENDING) {
    row = `${server.transport} · pending…`;
  } else if (server.status === McpConnectionStatus.FAILED && server.error) {
    row = `${server.transport} · failed · ${server.error}`;
  } else {
    row = `${server.transport} · ${server.status}`;
  }

  if (row.length <= maxWidth) return row;
  if (maxWidth <= 1) return "…";
  return `${row.slice(0, maxWidth - 1)}…`;
}

function truncateLine(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  return `${text.slice(0, maxWidth - 1)}…`;
}

type ConfigPathsProps = {
  paths: { global: string; project: string };
  bodyWidth: number;
};

function ConfigPaths({ paths, bodyWidth }: ConfigPathsProps) {
  return (
    <>
      <text attributes={TextAttributes.DIM}>
        Global: {truncatePathForDisplay(paths.global, bodyWidth - "Global: ".length)}
      </text>
      <text attributes={TextAttributes.DIM}>
        Project: {truncatePathForDisplay(paths.project, bodyWidth - "Project: ".length)}
      </text>
    </>
  );
}

/** Runtime MCP management dialog opened by `/mcp` (Phase 02, D-03). */
export function McpDialogContent() {
  const [refreshToken, setRefreshToken] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [busyServers, setBusyServers] = useState<ReadonlySet<string>>(() => new Set());
  /** Ref mirror of busy set — keyboard handlers read synchronously without stale closure. */
  const busyServersRef = useRef(new Set<string>());
  const { isTopLayer } = useKeyboardLayer();
  const { colors } = useTheme();
  const { show } = useToast();
  const dimensions = useTerminalDimensions();

  const bodyWidth = Math.min(DIALOG_MAX_WIDTH, dimensions.width - 4) - DIALOG_PADDING_X * 2;
  const paths = useMemo(() => getMcpConfigPaths(process.cwd()), []);
  const servers = useMemo(() => {
    void refreshToken;
    return getMcpManager().getStatus();
  }, [refreshToken]);

  const listViewportHeight =
    Math.min(servers.length, MCP_LIST_MAX_ITEMS) * MCP_ROW_HEIGHT;
  const pageSize = visibleItemCount(servers.length, MCP_LIST_MAX_ITEMS);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const suppressSelectionFromScrollRef = useRef(false);

  const selected = servers[selectedIndex];
  const bump = useCallback(() => setRefreshToken((value) => value + 1), []);

  const syncBusyServers = useCallback(() => {
    setBusyServers(new Set(busyServersRef.current));
  }, []);

  const tryAcquireBusy = useCallback(
    (serverName: string): boolean => {
      if (busyServersRef.current.has(serverName)) return false;
      busyServersRef.current.add(serverName);
      syncBusyServers();
      return true;
    },
    [syncBusyServers],
  );

  const releaseBusy = useCallback(
    (serverName: string) => {
      busyServersRef.current.delete(serverName);
      syncBusyServers();
    },
    [syncBusyServers],
  );

  const isServerBusy = useCallback((serverName: string) => busyServersRef.current.has(serverName), []);

  useEffect(() => {
    // Remote servers in backoff show PENDING — refresh list until connected or failed.
    const hasAutoPending = servers.some(
      (server) =>
        server.enabled &&
        server.status === McpConnectionStatus.PENDING &&
        !busyServersRef.current.has(server.name),
    );
    if (!hasAutoPending) return;

    const interval = setInterval(() => bump(), 1000);
    return () => clearInterval(interval);
  }, [servers, busyServers, bump]);

  const handleReconnect = useCallback(
    async (server: McpServerStatus) => {
      if (!tryAcquireBusy(server.name)) return;
      try {
        await getMcpManager().reconnect(server.name);
        bump();
      } catch (error) {
        show({
          variant: "error",
          message: error instanceof Error ? error.message : "Reconnect failed",
        });
      } finally {
        releaseBusy(server.name);
      }
    },
    [bump, releaseBusy, show, tryAcquireBusy],
  );

  const handleToggleEnabled = useCallback(
    async (server: McpServerStatus) => {
      if (!tryAcquireBusy(server.name)) return;
      try {
        setServerEnabled(server.name, !server.enabled, process.cwd());
        await getMcpManager().applyServerEnabledChange(server.name, !server.enabled, process.cwd());
        bump();
      } catch (error) {
        show({
          variant: "error",
          message: error instanceof Error ? error.message : "Failed to update MCP config",
        });
      } finally {
        releaseBusy(server.name);
      }
    },
    [bump, releaseBusy, show, tryAcquireBusy],
  );

  useKeyboard((key) => {
    if (!isTopLayer("dialog")) return;

    if (key.name === "return" || key.name === "enter") {
      if (selected && !isServerBusy(selected.name)) {
        void handleReconnect(selected);
      }
      return;
    }

    if (key.name === "t") {
      key.preventDefault();
      if (selected && !isServerBusy(selected.name)) {
        void handleToggleEnabled(selected);
      }
      return;
    }

    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setSelectedIndex((index) => moveDialogSelection(index, key.name as "up" | "down", servers.length));
    }
  });

  const handleScrollPositionChange = useCallback(
    (position: number) => {
      if (suppressSelectionFromScrollRef.current) return;
      setSelectedIndex(
        Math.min(servers.length - 1, Math.max(0, Math.floor(position / MCP_ROW_HEIGHT))),
      );
    },
    [servers.length],
  );

  useLayoutEffect(() => {
    const scrollbox = scrollRef.current;
    if (!scrollbox || servers.length === 0) return;
    suppressSelectionFromScrollRef.current = true;
    scrollIndexIntoView(scrollbox, selectedIndex, pageSize, MCP_ROW_HEIGHT);
    suppressSelectionFromScrollRef.current = false;
  }, [selectedIndex, servers.length, pageSize]);

  if (servers.length === 0) {
    return (
      <box flexDirection="column" gap={1}>
        <text attributes={TextAttributes.DIM}>No MCP servers configured.</text>
        <ConfigPaths paths={paths} bodyWidth={bodyWidth} />
      </box>
    );
  }

  return (
    <box flexDirection="column" gap={1}>
      <scrollbox
        ref={scrollRef}
        height={listViewportHeight}
        verticalScrollbarOptions={{ onChange: handleScrollPositionChange }}
      >
        {servers.map((server, index) => {
          const isSelected = index === selectedIndex;
          const isBusy = busyServers.has(server.name);
          const isPending =
            server.enabled && server.status === McpConnectionStatus.PENDING && !isBusy;
          return (
            <box
              key={server.name}
              flexDirection="column"
              height={MCP_ROW_HEIGHT}
              overflow="hidden"
              backgroundColor={isSelected ? colors.selection : undefined}
              onMouseMove={() => setSelectedIndex(index)}
            >
              <text selectable={false} fg={isSelected ? "black" : "white"} attributes={TextAttributes.BOLD}>
                {truncateLine(server.name, bodyWidth)}
              </text>
              <text
                selectable={false}
                fg={isBusy || isPending ? colors.info : isSelected ? "black" : "gray"}
                attributes={TextAttributes.DIM}
              >
                {formatStatusRow(server, bodyWidth, { busy: isBusy })}
              </text>
            </box>
          );
        })}
      </scrollbox>
      <text attributes={TextAttributes.DIM}>
        {busyServers.size > 0
          ? `Reconnecting ${[...busyServers].join(", ")}…`
          : "Enter reconnect · t toggle enabled · ↑↓ navigate"}
      </text>
      <ConfigPaths paths={paths} bodyWidth={bodyWidth} />
    </box>
  );
}
