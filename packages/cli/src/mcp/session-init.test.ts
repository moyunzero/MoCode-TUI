import { beforeEach, describe, expect, mock, test } from "bun:test";
import { initMcpOnSessionMount } from "./session-mcp";

describe("initMcpOnSessionMount", () => {
  const mockConnectAll = mock(async () => {});
  const mockDisconnectAll = mock(async () => {});
  const mockWatchMcpConfig = mock(() => {});
  const mockStopMcpWatcher = mock(() => {});

  const deps = {
    getManager: () => ({
      connectAll: mockConnectAll,
      disconnectAll: mockDisconnectAll,
    }),
    watchConfig: mockWatchMcpConfig,
    stopWatcher: mockStopMcpWatcher,
  };

  beforeEach(() => {
    mockConnectAll.mockClear();
    mockDisconnectAll.mockClear();
    mockWatchMcpConfig.mockClear();
    mockStopMcpWatcher.mockClear();
  });

  test("mount calls connectAll and watchMcpConfig once", () => {
    const cleanup = initMcpOnSessionMount("/tmp/project", deps);

    expect(mockConnectAll).toHaveBeenCalledTimes(1);
    expect(mockConnectAll).toHaveBeenCalledWith("/tmp/project");
    expect(mockWatchMcpConfig).toHaveBeenCalledTimes(1);
    expect(mockWatchMcpConfig).toHaveBeenCalledWith("/tmp/project");

    cleanup();
  });

  test("cleanup calls stopMcpWatcher and disconnectAll", () => {
    const cleanup = initMcpOnSessionMount("/tmp/project", deps);
    mockConnectAll.mockClear();
    mockWatchMcpConfig.mockClear();

    cleanup();

    expect(mockStopMcpWatcher).toHaveBeenCalledTimes(1);
    expect(mockDisconnectAll).toHaveBeenCalledTimes(1);
  });
});
