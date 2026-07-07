import type { Command } from "./types";
import { getAllCommands } from "../../lib/skills/registry";

/** Prefix match on command name; empty query returns the full list. */
export function getFilteredCommands(
  query: string,
  commands: Command[] = getAllCommands(),
): Command[] {
  if (query.length === 0) return commands;
  return commands.filter((command) => {
    return command.name.toLowerCase().startsWith(query.toLowerCase());
  });
}
