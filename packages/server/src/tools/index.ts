/**
 * Agent tool registry (Phase 8).
 *
 * Factory used by the chat route when `session.cwd` is set. Tools are bound to
 * that directory so all paths resolve inside the project sandbox. PLAN mode
 * exposes read-only exploration tools; BUILD mode adds mutation + shell.
 */
import type { Mode } from "@mocode/database/enums";
import { createReadFileTool } from "./read-file";
import { createListDirectoryTool } from "./list-directory";
import { createWriteFileTool } from "./write-file";
import { createEditFileTool } from "./edit-file";
import { createGrepTool } from "./grep";
import { createGlobTool } from "./glob";
import { createBashTool } from "./bash";

/** Returns the Vercel AI SDK tool map passed to `streamText({ tools })`. */
export function createTools(cwd: string, mode: Mode) {
  const readOnlyTools = {
    readFile: createReadFileTool(cwd),
    listDirectory: createListDirectoryTool(cwd),
    grep: createGrepTool(cwd),
    glob: createGlobTool(cwd),
  };

  if (mode === "PLAN") {
    return readOnlyTools;
  }

  return {
    ...readOnlyTools,
    writeFile: createWriteFileTool(cwd),
    editFile: createEditFileTool(cwd),
    bash: createBashTool(cwd),
  };
};