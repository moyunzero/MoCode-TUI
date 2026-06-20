/**
 * glob agent tool — find files matching a glob pattern under session.cwd.
 *
 * Results are sorted paths relative to cwd, capped at MAX_RESULTS. Skips
 * node_modules and hidden dotfiles (via Bun.Glob scan options).
 */
import { tool } from "ai";
import { z } from "zod";
import { resolve,relative } from "path";

const MAX_RESULTS = 200;

export function createGlobTool(cwd:string){
    return tool({
        description: "Search the project directory for files matching a glob pattern. Use this for finding files in the project directory.",
        inputSchema: z.object({
            pattern: z.string().describe("The glob pattern to search for. This pattern will be matched against the files in the project directory."),
            path: z.string().describe("The path to the file to edit relative to the project directory").default("."),
        }),
        execute: async ({ pattern,path }) => { 
            const resolved = resolve(cwd,path);
            if(!resolved.startsWith(cwd)) {
                return {error: "Path is outside of the project directory"};
            }
            try{
               const glob = new Bun.Glob(pattern);
               const files:string[] = [];
               let truncated = false;
               for await( const match of glob.scan({
                cwd: resolved,
                dot: false,
                onlyFiles: true,
               })) {
                    if(match.includes("node_modules")) continue;
                    if(files.length >= MAX_RESULTS) {
                        truncated = true;
                        break;
                    }
                    const absoluteMatch = resolve(resolved,match);
                    files.push(relative(cwd,absoluteMatch));
                }
                files.sort();

                return{
                    files,
                    ...(truncated ? {truncated: true as const} : {}),
                }  
            }catch(err){
                const message = err instanceof Error ? err.message : "An unknown error occurred";   
                return {
                    error: `Failed to search for files: ${path} - ${message}`
                }
            }
        },
    });
}