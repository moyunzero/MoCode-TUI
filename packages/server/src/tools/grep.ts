/**
 * grep agent tool — regex search over file contents under a directory.
 *
 */
import { tool } from "ai";
import { z } from "zod";
import { resolve,relative } from "path";
import { readFile } from "node:fs/promises";

const MAX_RESULTS = 50;

export function createGrepTool(cwd:string){
    return tool({
        description: "Search file contents in the project directory using a regular expression. Use this for finding code patterns, function definitions, imports, and other text in source files.",
        inputSchema: z.object({
            pattern: z.string().describe("The regular expression pattern to search for in file contents"),
            path: z.string().describe("The directory to search in, relative to the project directory").default("."),
            glob: z.string().optional().describe("Optional glob pattern to filter which files to search (e.g. \"**/*.ts\")"),
        }),
        execute: async ({ pattern,path,glob:fileGlob }) => {
            const resolved = resolve(cwd,path);
            if(!resolved.startsWith(cwd)) {
                return {error: "Path is outside of the project directory"};
            }
            try{
                const regex = new RegExp(pattern);
                const searchGlob = new Bun.Glob(fileGlob ?? "**/*");
                const matches: { file: string; line: number; content: string }[] = [];
                let truncated = false;

                for await(const match of searchGlob.scan({
                    cwd: resolved,
                    dot: false,
                    onlyFiles: true,
                })) {
                    // Hard skip: node_modules is never useful for agent exploration.
                    if(match.includes("node_modules")) continue;
                    if(truncated) break;

                    const absoluteMatch = resolve(resolved,match);
                    try{
                        const content = await readFile(absoluteMatch,"utf-8");
                        const lines = content.split("\n");
                        for(let i = 0; i < lines.length; i++) {
                            const line = lines[i];
                            if(line === undefined || !regex.test(line)) continue;
                            if(matches.length >= MAX_RESULTS) {
                                truncated = true;
                                break;
                            }
                            matches.push({
                                file: relative(cwd,absoluteMatch),
                                line: i + 1,
                                content: line.trim(),
                            });
                        }
                    }catch{
                        continue;
                    }
                }

                return {
                    matches,
                    ...(truncated ? {truncated: true as const} : {}),
                };
            }catch(err){
                const message = err instanceof Error ? err.message : "An unknown error occurred";
                return {
                    error: `Failed to search files: ${path} - ${message}`,
                };
            }
        },
    });
}
