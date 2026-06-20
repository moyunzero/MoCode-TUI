/**
 * editFile agent tool — string-replace edits (BUILD mode only).
 *
 * Replaces all occurrences of `oldString` globally. The model is instructed to
 * supply enough context in oldString so matches are unambiguous; zero matches
 * returns an error rather than silently no-oping.
 */
import { tool } from "ai";
import { z } from "zod";
import { resolve,relative } from "path";
import { readFile, writeFile } from "fs/promises";

export function createEditFileTool(cwd:string){
    return tool({
        description: "Edit a file in the project directory. Use this for making small changes to the codebase. The file will be saved in the same directory as the project directory.",
        inputSchema: z.object({
            path: z.string().describe("The path to the file to edit relative to the project directory"),
            oldString: z.string().describe("The old string to replace. This string will be replaced with the new string."),
            newString: z.string().describe("The new string to replace the old string with. This string will be replaced with the new string."),
        }),
        execute: async ({ path, oldString, newString }) => {
            const resolved = resolve(cwd,path);
            if(!resolved.startsWith(cwd)) {
                return {error: "Path is outside of the project directory"};
            }
            
            try{
                const content = await readFile(resolved,"utf-8");
                const occurrences = content.split(oldString).length - 1;
                if(occurrences === 0) {
                    return {error: `No occurrences of "${oldString}" found in ${path}`};
                }

               // Global replace; model should pass a unique oldString snippet.
               const updated = content.replace(new RegExp(oldString,"g"),newString);
               await writeFile(resolved,updated,"utf-8");
               return {
                success: true as const,
                path: relative(cwd,resolved),
               };
            }catch(err){
                const message = err instanceof Error ? err.message : "An unknown error occurred";
                return {
                    error: `Failed to edit file: ${path} - ${message}`
                }
            }
        }
    });
}