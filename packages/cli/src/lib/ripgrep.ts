/**
 * Ripgrep spawn wrapper for the grep tool (HARNESS-01).
 *
 * Uses @vscode/ripgrep bundled binary when available, falls back to system `rg`.
 * Respects .gitignore natively — no manual --exclude-dir hacks.
 */
import { accessSync } from "fs";
import { relative } from "path";
import { rgPath } from "@vscode/ripgrep";

/** Max grep match rows returned before `truncated: true`. */
const MAX_MATCHES = 50;

/**
 * Resolve the ripgrep binary path.
 * @throws when neither bundled nor system ripgrep is available.
 */
export function resolveRgBinary(): string {
  try {
    accessSync(rgPath);
    return rgPath;
  } catch {
    const systemRg = Bun.which("rg");
    if (systemRg) return systemRg;
    throw new Error(
      "ripgrep not found: install @vscode/ripgrep or add rg to PATH",
    );
  }
}

/**
 * Search file contents with ripgrep under `resolved` path.
 * Exit code 1 (no matches) is treated as success with empty results.
 */
export async function runRipgrep(
  cwd: string,
  resolved: string,
  pattern: string,
  include?: string,
) {
  const binary = resolveRgBinary();
  // --no-require-git: apply .gitignore even outside a git repo (Phase 01 / HARNESS-01).
  // Without it, ripgrep ignores .gitignore in temp dirs and non-git project roots.
  const args = [
    "--line-number",
    "--no-heading",
    "--color=never",
    "--no-require-git",
    "--with-filename",
  ];
  if (include) args.push("--glob", include);
  args.push("--", pattern, resolved);

  const proc = Bun.spawn([binary, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  if (exitCode !== 0 && exitCode !== 1) throw new Error(`grep failed: ${stderr.trim()}`);
  if (!stdout.trim()) return { matches: [], message: "No matches found" };

  const lines = stdout.trim().split("\n");
  const matches: { file: string; line: number; content: string }[] = [];
  let truncated = false;

  for (const line of lines) {
    if (matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    const match = line.match(/^(.+?):(\d+):(.*)$/);
    if (match) {
      matches.push({
        file: relative(cwd, match[1]!),
        line: Number(match[2]),
        content: match[3]!,
      });
    }
  }

  return { matches, ...(truncated ? { truncated: true, totalMatches: lines.length } : {}) };
}
