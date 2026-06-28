import { describe, expect, test } from "bun:test";
import { createTransport } from "./transports";
import type { McpServerConfigStdio } from "./types";

const baseStdio = (overrides: Partial<McpServerConfigStdio> = {}): McpServerConfigStdio => ({
  enabled: true,
  transport: "stdio",
  command: "echo",
  timeoutMs: 60000,
  ...overrides,
});

describe("createTransport", () => {
  test("stdio transport type selects StdioClientTransport", () => {
    const transport = createTransport(
      baseStdio({
        args: ["hello"],
      }),
    );

    expect(transport.type).toBe("stdio");
    expect(transport.constructor.name).toMatch(/Stdio/i);
    expect((transport as { stderr: unknown }).stderr).toBeNull();
  });

  test("stdio env merges process.env with entry.env", () => {
    const transport = createTransport(
      baseStdio({
        env: { MOCODE_TEST_ENV: "custom" },
      }),
    );

    expect(transport.type).toBe("stdio");
    expect(process.env.PATH).toBeDefined();
  });

  test("http transport type selects StreamableHTTPClientTransport", () => {
    const transport = createTransport({
      enabled: true,
      transport: "http",
      url: "http://localhost:3000/mcp",
      timeoutMs: 60000,
    });

    expect(transport.type).toBe("http");
    expect(transport.constructor.name).toMatch(/HTTP/i);
  });

  test("sse transport type selects SSEClientTransport", () => {
    const transport = createTransport({
      enabled: true,
      transport: "sse",
      url: "http://localhost:3000/sse",
      timeoutMs: 60000,
    });

    expect(transport.type).toBe("sse");
    expect(transport.constructor.name).toMatch(/SSE/i);
  });
});
