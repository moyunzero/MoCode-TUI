import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager } from "./manager";

async function isNpxAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["npx", "--version"], { stdout: "pipe", stderr: "pipe" });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

describe("MCP stdio integration", () => {
  test("connectAll discovers tools from filesystem MCP server", async () => {
    if (!process.env.RUN_MCP_INTEGRATION_TESTS || !(await isNpxAvailable())) {
      console.warn("SKIP: MCP integration test disabled or npx unavailable");
      return;
    }

    const tempRoot = mkdtempSync(join(tmpdir(), "mocode-mcp-integration-"));
    const serverDir = mkdtempSync(join(tempRoot, "server-root-"));
    const projectDir = mkdtempSync(join(tempRoot, "project-"));
    const configDir = join(projectDir, ".mocode");
    mkdirSync(configDir, { recursive: true });
    const manager = new McpManager();

    writeFileSync(
      join(configDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          filesystem: {
            enabled: true,
            transport: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", serverDir],
            timeoutMs: 60000,
          },
        },
      }),
    );

    try {
      await manager.connectAll(projectDir);

      const discovered = manager.getDiscoveredTools();
      expect(discovered.length).toBeGreaterThan(0);
      expect(discovered[0]?.serverName).toBe("filesystem");
      expect(discovered[0]?.tools.length).toBeGreaterThan(0);
      expect(manager.getStatus()[0]?.status).toBe("connected");
    } finally {
      await manager.disconnectAll();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
