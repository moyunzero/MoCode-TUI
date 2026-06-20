/**
 * bash agent tool — runs shell commands in session.cwd (BUILD mode only).
 *
 * Uses Bun.spawn with a wall-clock timeout and truncates stdout/stderr so long
 * build logs do not blow the context window. TERM=dumb avoids escape-sequence noise.
 */
import { tool } from "ai";
import { z } from "zod";

const MAX_OUTPUT = 20_000;
const DEFAULT_TIMEOUT = 30_000;

export function createBashTool(cwd:string){
    return tool({
        description: "Execute a shell command in the project directory. Use this for running tests,builds,git operations,package installs,and any other shell commands",
        inputSchema: z.object({
            command: z.string().describe("The shell command to execute"),
            timeout: z.number().describe("The timeout in milliseconds for the command to execute. Defaults to 30 seconds").default(DEFAULT_TIMEOUT),
        }),
        execute: async ({ command, timeout }) => {
            try{
                const proc = Bun.spawn(["bash","-c",command],{
                    cwd,
                    stdout: "pipe",
                    stderr: "pipe",
                    env: { ...process.env,TERM: "dumb"},
                });

                // Kill the process if it exceeds the model-supplied (or default) timeout.
                const timer = setTimeout(()=>{
                    proc.kill();
                },timeout);
                const [stdout, stderr] = await Promise.all([
                    new Response(proc.stdout).text(),
                    new Response(proc.stderr).text(),
                ]);

                const exitCode = await proc.exited;
                clearTimeout(timer);

                const truncate = (s:string) =>{
                    return s.length > MAX_OUTPUT ? s.slice(0,MAX_OUTPUT) + `\n... (truncated,${s.length} total chars)` : s;
                }

                return {
                    stdout: truncate(stdout),
                    stderr: truncate(stderr),
                    exitCode,
                }

            }catch(err){
                const message = err instanceof Error ? err.message : "An unknown error occurred";
                return {
                   error: `Failed to execute command: ${message}`
                }
            }
        },
    });
}