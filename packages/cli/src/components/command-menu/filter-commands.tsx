import type { Command } from "./types";
import { COMMANDS } from "./commands";

/** Prefix match on command name; empty query returns the full list. */
export function getFilteredCommands(query:string):Command[] {
    if(query.length === 0) return COMMANDS;
    return COMMANDS.filter((command) => {
        return command.name.toLowerCase().startsWith(query.toLowerCase());
    });
}