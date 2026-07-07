/**
 * Hooks config loader — union merge of global and project hooks.json (Phase 04, D-33).
 *
 * Merge rule: project hook entries override global entries with the same `id`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hooksConfigSchema, type HookEntry, type HooksConfig } from "./schema";

const CONFIG_DIR = ".mocode";
const HOOKS_FILE = "hooks.json";

export type HooksConfigPaths = {
  global: string;
  project: string;
};

export type LoadMergedHooksConfigOptions = {
  globalPath?: string;
  projectPath?: string;
};

/** Returns filesystem paths for global and project hooks config files. */
export function getHooksConfigPaths(cwd: string): HooksConfigPaths {
  return {
    global: join(homedir(), CONFIG_DIR, HOOKS_FILE),
    project: join(cwd, CONFIG_DIR, HOOKS_FILE),
  };
}

function readHooksJsonFile(path: string): Record<string, unknown> {
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {};
    }
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid hooks config at ${path}: ${error.message}`);
    }
    throw error;
  }
}

function parseHooksRaw(raw: Record<string, unknown>): HookEntry[] {
  const result = hooksConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid hooks config: ${result.error.message}`);
  }
  return result.data.hooks;
}

function mergeHooksById(globalHooks: HookEntry[], projectHooks: HookEntry[]): HookEntry[] {
  const merged = new Map<string, HookEntry>();
  for (const hook of globalHooks) {
    merged.set(hook.id, hook);
  }
  for (const hook of projectHooks) {
    merged.set(hook.id, hook);
  }
  return [...merged.values()];
}

/**
 * Loads and validates hooks config by merging global ~/.mocode/hooks.json with
 * project .mocode/hooks.json. Project entries override global entries by `id`.
 */
export function loadMergedHooksConfig(
  cwd: string,
  options?: LoadMergedHooksConfigOptions,
): HooksConfig {
  const paths =
    options?.globalPath && options?.projectPath
      ? { global: options.globalPath, project: options.projectPath }
      : getHooksConfigPaths(cwd);

  const globalHooks = parseHooksRaw(readHooksJsonFile(paths.global));
  const projectHooks = parseHooksRaw(readHooksJsonFile(paths.project));

  return {
    hooks: mergeHooksById(globalHooks, projectHooks),
  };
}
