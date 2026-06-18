/**
 * Smoke test for free-tier provider API keys in `.env`.
 *
 * For each configured model: runs a minimal completion, then a forced tool call.
 * Exits 1 when any executed check fails (missing keys are skipped).
 */
import dotenv from "dotenv";
import path from "path";
import { generateText, tool } from "ai";
import { z } from "zod";

import { resolveChatModel } from "../src/lib/model";

dotenv.config({
    path: path.resolve(import.meta.dirname, "../../../.env"),
});

const BASIC_TIMEOUT_MS = 60_000;
const TOOL_TIMEOUT_MS = 90_000;

/** Free models exercised when the matching env var is present. */
const FREE_MODELS = [
    {
        modelId: "gemini-2.5-flash",
        envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    },
    {
        modelId: "llama-3.3-70b-versatile",
        envKey: "GROQ_API_KEY",
    },
    {
        modelId: "gpt-oss-120b",
        envKey: "CEREBRAS_API_KEY",
    },
    {
        modelId: "openai/gpt-oss-120b:free",
        envKey: "OPENROUTER_API_KEY",
    },
] as const;

const BASIC_PROMPT = "Reply with exactly: OK";
const TOOL_PROMPT = "What is the weather in Tokyo? Use the getWeather tool.";

const weatherTool = tool({
    description: "Get weather for a city",
    inputSchema: z.object({ city: z.string() }),
    execute: async ({ city }) => ({ city, temp: 22, unit: "C" }),
});

type CheckStatus = "pass" | "skip" | "fail";

type CheckResult = {
    status: CheckStatus;
    latencyMs?: number;
    detail?: string;
    error?: string;
};

type TestResult = {
    modelId: string;
    basic: CheckResult;
    tool: CheckResult;
};

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);

        promise
            .then(resolve, reject)
            .finally(() => clearTimeout(timeoutId));
    });
}

async function testBasic(modelId: string): Promise<CheckResult> {
    const start = Date.now();
    try {
        const resolved = resolveChatModel(modelId);
        const { text } = await withTimeout(
            generateText({
                model: resolved.model,
                prompt: BASIC_PROMPT,
                maxOutputTokens: 16,
            }),
            BASIC_TIMEOUT_MS,
            "basic",
        );
        return {
            status: "pass",
            latencyMs: Date.now() - start,
            detail: text.trim(),
        };
    } catch (err) {
        return {
            status: "fail",
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

async function testTool(modelId: string): Promise<CheckResult> {
    const start = Date.now();
    try {
        const resolved = resolveChatModel(modelId);
        const result = await withTimeout(
            generateText({
                model: resolved.model,
                tools: { getWeather: weatherTool },
                toolChoice: "required",
                prompt: TOOL_PROMPT,
                maxOutputTokens: 256,
            }),
            TOOL_TIMEOUT_MS,
            "tool",
        );
        const toolCalls = result.toolCalls?.length ?? 0;
        const toolResults = result.toolResults?.length ?? 0;
        if (toolCalls === 0 || toolResults === 0) {
            return {
                status: "fail",
                latencyMs: Date.now() - start,
                error: `expected tool call, got calls=${toolCalls} results=${toolResults}`,
            };
        }
        return {
            status: "pass",
            latencyMs: Date.now() - start,
            detail: `calls=${toolCalls} results=${toolResults}`,
        };
    } catch (err) {
        return {
            status: "fail",
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

function printCheck(label: string, result: CheckResult) {
    const icon = result.status === "pass" ? "✓" : result.status === "skip" ? "○" : "✗";
    console.log(`  ${icon} ${label}`);
    if (result.latencyMs !== undefined) {
        console.log(`    latency: ${result.latencyMs}ms`);
    }
    if (result.detail) {
        console.log(`    ${result.detail}`);
    }
    if (result.error) {
        console.log(`    ${result.status === "skip" ? "reason" : "error"}: ${result.error}`);
    }
}

const results: TestResult[] = [];

for (const { modelId, envKey } of FREE_MODELS) {
    if (!process.env[envKey]) {
        const skipped: CheckResult = {
            status: "skip",
            error: `${envKey} not set`,
        };
        results.push({ modelId, basic: skipped, tool: skipped });
        continue;
    }

    const basic = await testBasic(modelId);
    // Tool check is expensive; skip when the provider cannot complete a plain prompt.
    const toolCheck =
        basic.status === "pass"
            ? await testTool(modelId)
            : {
                  status: "skip" as const,
                  error: "skipped because basic test failed",
              };

    results.push({ modelId, basic, tool: toolCheck });
}

console.log("\nProvider connectivity test\n");
for (const result of results) {
    console.log(result.modelId);
    printCheck("basic", result.basic);
    printCheck("tool", result.tool);
    console.log();
}

const failed = results.filter(
    (result) => result.basic.status === "fail" || result.tool.status === "fail",
);
if (failed.length > 0) {
    process.exit(1);
}
