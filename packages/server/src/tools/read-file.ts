/**
 * readFile agent tool — reads UTF-8 text under session.cwd.
 *
 * Large files are truncated to keep tool results within model context limits.
 * Paths outside cwd are rejected (same sandbox rule as all file tools).
 */
import { resolve, relative } from "path";
import { readFile } from "fs/promises";
import { tool } from "ai";
import { z } from "zod";

/** Max characters returned; larger files include `truncated: true` in the result. */
const MAX_FILE_SIZE = 10_000;

export function createReadFileTool(cwd: string) {
  return tool({
    description:
      "Read the contents of a file in the project. Returns the file text, truncated if very large.",
    inputSchema: z.object({
      path: z.string().describe("Relative path to the file to read"),
    }),
    execute: async ({ path }) => {
      const resolved = resolve(cwd, path);
      const rel = relative(cwd, resolved);

      // Block path traversal (e.g. "../../etc/passwd") before touching the filesystem.
      if (
        rel.startsWith("..") ||
        (resolve(resolved) !== resolved && rel.startsWith(".."))
      ) {
        return { error: "Path is outside the project directory" };
      }

      // Secondary guard: resolved absolute path must stay under cwd prefix.
      if (!resolved.startsWith(cwd)) {
        return { error: "Path is outside the project directory" };
      }

      try {
        const content = await readFile(resolved, "utf-8");
        if (content.length > MAX_FILE_SIZE) {
          return {
            content: content.slice(0, MAX_FILE_SIZE),
            truncated: true,
            totalLength: content.length,
          };
        }
        return { content };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { error: `Failed to read file: ${message}` };
      }
    },
  })
};