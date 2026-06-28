import { afterEach, describe, expect, mock, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServerEntry } from "./config-schema";
import { McpConnectionStatus } from "./types";
import { McpManager } from "./manager";

type ScheduledTimer = {
  delay: number;
  callback: () => void;
};

function createMockClient(overrides: Partial<Client> = {}): Client {
  return {
    connect: mock(async () => {}),
    close: mock(async () => {}),
    callTool: mock(async () => ({ content: [] })),
    listTools: mock(async () => ({ tools: [{ name: "list_files", description: "List files" }] })),
    ...overrides,
  } as unknown as Client;
}

function createTimerHarness() {
  const scheduled: ScheduledTimer[] = [];

  return {
    scheduled,
    setTimer: (callback: () => void, delay: number) => {
      scheduled.push({ delay, callback });
      return scheduled.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
    runNext: async () => {
      const next = scheduled.shift();
      next?.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const httpServer: McpServerEntry = {
  enabled: true,
  transport: "http",
  url: "http://127.0.0.1:9999/mcp",
  timeoutMs: 60000,
};

const stdioServer: McpServerEntry = {
  enabled: true,
  transport: "stdio",
  command: "echo",
  timeoutMs: 45000,
};

describe("McpManager", () => {
  afterEach(() => {
    mock.restore();
  });

  test("connectAll sets status connected for mock server", async () => {
    const client = createMockClient();
    const manager = new McpManager({
      loadConfig: () => ({ mcpServers: { fs: stdioServer } }),
      createClient: () => client,
      createTransportFn: () => ({ type: "stdio" }) as ReturnType<typeof import("./transports").createTransport>,
    });

    await manager.connectAll("/tmp/project");

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.listTools).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toEqual([
      {
        name: "fs",
        transport: "stdio",
        status: McpConnectionStatus.CONNECTED,
        enabled: true,
        error: undefined,
        toolCount: 1,
      },
    ]);
  });

  test("HTTP failure schedules reconnect with doubling delay up to 5 attempts", async () => {
    const timers = createTimerHarness();
    let connectCalls = 0;
    const client = createMockClient({
      connect: mock(async () => {
        connectCalls += 1;
        throw new Error("connection refused");
      }),
    });

    const manager = new McpManager({
      loadConfig: () => ({ mcpServers: { remote: httpServer } }),
      createClient: () => client,
      createTransportFn: () => ({ type: "http" }) as ReturnType<typeof import("./transports").createTransport>,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await manager.connectAll("/tmp/project");
    expect(connectCalls).toBe(1);
    expect(manager.getStatus()[0]?.status).toBe(McpConnectionStatus.PENDING);

    for (let retry = 1; retry <= 5; retry += 1) {
      expect(timers.scheduled).toHaveLength(1);
      expect(timers.scheduled[0]?.delay).toBe(1000 * 2 ** (retry - 1));
      await timers.runNext();
      expect(connectCalls).toBe(1 + retry);
    }

    expect(timers.scheduled).toHaveLength(0);
    expect(manager.getStatus()[0]?.status).toBe(McpConnectionStatus.FAILED);
  });

  test("stdio failure does not schedule reconnect", async () => {
    const timers = createTimerHarness();
    const client = createMockClient({
      connect: mock(async () => {
        throw new Error("spawn failed");
      }),
    });

    const manager = new McpManager({
      loadConfig: () => ({ mcpServers: { local: stdioServer } }),
      createClient: () => client,
      createTransportFn: () => ({ type: "stdio" }) as ReturnType<typeof import("./transports").createTransport>,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await manager.connectAll("/tmp/project");

    expect(timers.scheduled).toHaveLength(0);
    expect(manager.getStatus()[0]?.status).toBe(McpConnectionStatus.FAILED);
  });

  test("callTool passes timeout from server timeoutMs", async () => {
    const client = createMockClient();
    const manager = new McpManager({
      loadConfig: () => ({ mcpServers: { local: stdioServer } }),
      createClient: () => client,
      createTransportFn: () => ({ type: "stdio" }) as ReturnType<typeof import("./transports").createTransport>,
    });

    await manager.connectAll("/tmp/project");
    await manager.callTool("local", "list_files", { path: "." });

    expect(client.callTool).toHaveBeenCalledWith(
      { name: "list_files", arguments: { path: "." } },
      undefined,
      { timeout: 45000, resetTimeoutOnProgress: true },
    );
  });

  test("reconnect resets attempts and retries connect once", async () => {
    let shouldFail = true;
    const client = createMockClient({
      connect: mock(async () => {
        if (shouldFail) {
          throw new Error("temporary failure");
        }
      }),
    });
    const timers = createTimerHarness();

    const manager = new McpManager({
      loadConfig: () => ({ mcpServers: { remote: httpServer } }),
      createClient: () => client,
      createTransportFn: () => ({ type: "http" }) as ReturnType<typeof import("./transports").createTransport>,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    await manager.connectAll("/tmp/project");
    expect(manager.getStatus()[0]?.status).toBe(McpConnectionStatus.PENDING);

    shouldFail = false;
    await manager.reconnect("remote");

    expect(client.connect).toHaveBeenCalledTimes(2);
    expect(manager.getStatus()[0]?.status).toBe(McpConnectionStatus.CONNECTED);
    expect(manager.getStatus()[0]?.toolCount).toBe(1);
  });

  test("applyServerEnabledChange only affects the toggled server", async () => {
    let fsEnabled = true;
    let connectCalls = 0;
    const client = createMockClient({
      connect: mock(async () => {
        connectCalls += 1;
      }),
    });

    const manager = new McpManager({
      loadConfig: () => ({
        mcpServers: {
          fs: { ...stdioServer, enabled: fsEnabled },
          other: stdioServer,
        },
      }),
      createClient: () => client,
      createTransportFn: () => ({ type: "stdio" }) as ReturnType<typeof import("./transports").createTransport>,
    });

    await manager.connectAll("/tmp/project");
    expect(connectCalls).toBe(2);

    fsEnabled = false;
    await manager.applyServerEnabledChange("fs", false, "/tmp/project");

    expect(manager.getStatus().find((server) => server.name === "fs")).toEqual({
      name: "fs",
      transport: "stdio",
      status: McpConnectionStatus.DISABLED,
      enabled: false,
      error: undefined,
      toolCount: undefined,
    });
    expect(manager.getStatus().find((server) => server.name === "other")?.status).toBe(
      McpConnectionStatus.CONNECTED,
    );
    expect(connectCalls).toBe(2);

    fsEnabled = true;
    await manager.applyServerEnabledChange("fs", true, "/tmp/project");

    expect(connectCalls).toBe(3);
    expect(manager.getStatus().find((server) => server.name === "fs")?.status).toBe(
      McpConnectionStatus.CONNECTED,
    );
  });
});
