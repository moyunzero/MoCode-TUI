import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { FSWatcher } from "chokidar";
import type { McpManager } from "./manager";
import { stopMcpWatcher, watchMcpConfig } from "./watcher";

type ChangeHandler = (path: string) => void;

describe("watchMcpConfig", () => {
  const changeHandlers: ChangeHandler[] = [];
  const mockWatcherClose = mock(async () => {});
  const mockDisconnectAll = mock(async () => {});
  const mockConnectAll = mock(async () => {});
  const scheduledTimers: Array<{ delay: number; callback: () => void }> = [];

  const mockWatch = mock((_path: string) => ({
    on: mock((event: string, handler: ChangeHandler) => {
      if (event === "change" || event === "add" || event === "unlink") {
        changeHandlers.push(handler);
      }
    }),
    close: mockWatcherClose,
  })) as unknown as (path: string) => FSWatcher;

  const mockSetTimer = mock((callback: () => void, delay: number) => {
    scheduledTimers.push({ delay, callback });
    return scheduledTimers.length as unknown as ReturnType<typeof setTimeout>;
  });

  const mockClearTimer = mock((_id: ReturnType<typeof setTimeout>) => {});
  const mockExists = mock(() => true);

  const mockManager = {
    disconnectAll: mockDisconnectAll,
    connectAll: mockConnectAll,
  } as unknown as McpManager;

  const testDeps = {
    watch: mockWatch,
    setTimer: mockSetTimer,
    clearTimer: mockClearTimer,
    exists: mockExists,
    getManager: () => mockManager,
    getPaths: () => ({
      global: "/home/user/.mocode/mcp.json",
      project: "/tmp/project/.mocode/mcp.json",
    }),
  };

  beforeEach(() => {
    stopMcpWatcher(testDeps);
    changeHandlers.length = 0;
    scheduledTimers.length = 0;
    mockWatch.mockClear();
    mockWatcherClose.mockClear();
    mockDisconnectAll.mockClear();
    mockConnectAll.mockClear();
    mockSetTimer.mockClear();
    mockClearTimer.mockClear();
  });

  afterEach(() => {
    stopMcpWatcher(testDeps);
  });

  test("registers watchers on global and project mcp.json paths", () => {
    watchMcpConfig("/tmp/project", undefined, testDeps);

    expect(mockWatch).toHaveBeenCalledTimes(2);
    expect(mockWatch).toHaveBeenCalledWith("/home/user/.mocode/mcp.json", { ignoreInitial: true });
    expect(mockWatch).toHaveBeenCalledWith("/tmp/project/.mocode/mcp.json", { ignoreInitial: true });
  });

  test("debounces rapid changes into one reload after 300ms", async () => {
    watchMcpConfig("/tmp/project", undefined, testDeps);

    changeHandlers[0]?.("/home/user/.mocode/mcp.json");
    changeHandlers[0]?.("/home/user/.mocode/mcp.json");

    expect(mockDisconnectAll).toHaveBeenCalledTimes(0);
    expect(mockConnectAll).toHaveBeenCalledTimes(0);
    expect(mockClearTimer).toHaveBeenCalledTimes(1);

    const lastTimer = scheduledTimers.at(-1);
    expect(lastTimer?.delay).toBe(300);

    await lastTimer?.callback();

    expect(mockDisconnectAll).toHaveBeenCalledTimes(1);
    expect(mockConnectAll).toHaveBeenCalledTimes(1);
    expect(mockConnectAll).toHaveBeenCalledWith("/tmp/project");
  });

  test("stopMcpWatcher closes chokidar handles", async () => {
    watchMcpConfig("/tmp/project", undefined, testDeps);

    stopMcpWatcher(testDeps);

    expect(mockWatcherClose).toHaveBeenCalledTimes(2);
  });
});
