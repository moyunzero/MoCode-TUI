/**
 * Chat HTTP routes: submit a user turn and stream the assistant reply via SSE.
 *
 * Phase 8 extends the stream with:
 * - Multi-step agent loop via `streamText({ tools, stopWhen: stepCountIs(50) })`
 * - Reasoning, tool-call, and tool-result SSE events (mirrored in Message.parts)
 * - System prompt and cwd-scoped tools when session.cwd is set
 *
 * Phase 9 scopes every session lookup by `userId` from `requireAuth`, so users
 * can only chat in sessions they own.
 *
 * Persists USER / ASSISTANT / ERROR rows to the database. Interrupted streams
 * (client disconnect or abort) save partial ASSISTANT content with INTERRUPTED
 * status. Resume replays generation when the last stored message is USER-only.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import { streamText as aiStreamText, stepCountIs } from "ai";
import { db } from "@mocode/database/client";
import { Mode, MessageStatus } from "@mocode/database/enums";
import { 
    type ChatStreamEvent,
    type MessagePart,
    toolCallArgsSchema,
    messagePartsSchema,
 } from "@mocode/shared";
import { isSupportedChatModel, resolveChatModel } from "../lib/model";
import type { Prisma } from "@mocode/database";
import { createTools } from "../tools";
import { buildSystemPrompt } from "../system-prompt";
import type { AuthenticatedEnv } from "../middleware/require-auth";

const submitSchema = z.object({
    content: z.string(),
    mode: z.enum(Mode),
    // Shared catalog guard; rejects unknown model ids before hitting the provider SDK.
    model: z.string().refine(isSupportedChatModel, "Invalid model"),
})

const submitValidator = zValidator("json", submitSchema, (result, c) => {
    if(!result.success){
        return c.json({ error: result.error.message }, 400);
    }
});

/** Prevents duplicate resume SSE connections for the same session (held for stream lifetime). */
const activeResumeSessionIds = new Set<string>();

/**
 * Maps DB messages to Vercel AI SDK `messages` shape.
 * Skips ERROR rows and empty assistant placeholders left by interrupted runs.
 */
function buildConversationHistory(
    messages: {
        role: "USER" | "ASSISTANT" | "ERROR";
        content: string;
        status: MessageStatus;
    }[]
){
    return messages.flatMap((msg)=>{
        if(msg.role === "ERROR"){
            return []
        }
        // Empty assistant rows can remain after a failed/interrupted run; omit from LLM context.
        if(msg.role === "ASSISTANT" && msg.content.length=== 0){
            return []
        }
        return [
            {
                role: msg.role === "USER" ? ("user" as const) : ("assistant" as const),
                content: msg.content,
            }
        ]
    })
}

/** Returns the trailing user message when the assistant never finished replying. */
function getResumableUserMessage(
    messages:{
        role: "USER" | "ASSISTANT" | "ERROR";
        model:string;
        mode:Mode;
    }[],
){
    const lastMessage = messages[messages.length -1 ];
    if(!lastMessage || lastMessage.role !== "USER"){
        return null;
    }
    return lastMessage;
}

type StreamParams = {
    sessionId: string;
    model: string;
    /** Session working directory; when null, tools are disabled (plain chat only). */
    cwd: string | null;
    history: {
        role: "user" | "assistant";
        content: string;
    }[];
    mode: Mode;
    abortController: AbortController;
}  

/**
 * Runs the agent loop via `streamText`, forwards stream chunks as SSE, then persists
 * the final assistant row (or handles abort/error paths).
 *
 * Accumulates {@link MessagePart} segments in `parts` while iterating `fullStream`:
 * - reasoning-delta → coalesced reasoning parts + SSE
 * - text-delta → coalesced text parts + SSE (also joined into Message.content)
 * - tool-call / tool-result → structured tool parts + SSE
 *
 * `Message.content` remains plain assistant text for backward-compatible history;
 * rich segments live in `Message.parts` JSON.
 */
async function streamAIResponse(
    stream:Parameters<Parameters<typeof streamSSE>[1]>[0],
    params: StreamParams
){
    const { sessionId, model, history, mode, abortController, cwd } = params;

    const startTime = Date.now();
    const resolvedModel = resolveChatModel(model);
    /** Ordered segments persisted to Message.parts and mirrored on the wire. */
    const parts: MessagePart[] = [];
    /** Undefined when cwd is missing — agent runs in text-only mode without tools. */
    const tools = cwd ? createTools(cwd, mode) : undefined;

    /** Writes partial output when the client disconnects before `done`. */
    const persistInterruptedMessage = async ()=>{

        // content column = concatenated text parts only (reasoning/tools omitted).
        const fullText = parts
            .filter((p)=> p.type === "text")
            .map((p)=> p.text)
            .join("");

        if(fullText.length === 0 && parts.length === 0) return;

        const elapsedMs = Date.now() - startTime;
        const validateParts: Prisma.InputJsonValue | undefined = parts.length > 0 ? messagePartsSchema.parse(parts) : undefined;

        await db.message.create({
            data:{
                sessionId,
                role: "ASSISTANT",
                status:MessageStatus.INTERRUPTED,
                content: fullText,
                model,
                mode,
                parts: validateParts,
                duration: Math.round(elapsedMs/1000), // seconds in DB; see `done.durationMs` on wire
            }
        })
    }
    
    try{
        const result = aiStreamText({
            model: resolvedModel.model,
            messages:history,
            abortSignal: abortController.signal,
            providerOptions: resolvedModel.providerOptions,
            tools,
            system: buildSystemPrompt({cwd, mode}),
            // Cap agent steps to avoid runaway tool loops; only applied when tools exist.
            stopWhen: tools ? stepCountIs(50) : undefined,
        });
        
        for await (const chunk of result.fullStream){
            if(stream.aborted) break;

            // Provider-native thinking/reasoning tokens (Anthropic, OpenAI, Gemini, etc.).
            if(chunk.type === "reasoning-delta"){
                const last = parts[parts.length - 1];
                if(last && last.type === "reasoning"){
                    last.text += chunk.text;
                }else{
                    parts.push({ type: "reasoning", text: chunk.text });
                }
                const event: ChatStreamEvent = {
                    type: "reasoning-delta",
                    text: chunk.text,
                }
                await stream.writeSSE({
                    event: "reasoning-delta",
                    data: JSON.stringify(event)
                })
            }
            
            if(chunk.type === "text-delta"){
                const last = parts[parts.length - 1];
                if(last && last.type === "text"){
                    last.text += chunk.text;
                }else{
                    parts.push({ type: "text", text: chunk.text });
                }

                const event: ChatStreamEvent = {
                    type: "text-delta",
                    text: chunk.text,
                }
                // Event name mirrors `type` so clients can filter without parsing data first.
                await stream.writeSSE({
                    event:"text-delta", 
                    data: JSON.stringify(event)
                });     
            }

            if(chunk.type === "tool-call"){
                const args = toolCallArgsSchema.parse(chunk.input);
                parts.push({
                    type: "tool-call",
                    id: chunk.toolCallId,
                    name: chunk.toolName,
                    args,
                });

                // Result is attached later when the matching tool-result chunk arrives.
                const event: ChatStreamEvent = {
                    type: "tool-call",
                    toolCallId: chunk.toolCallId,
                    toolName: chunk.toolName,
                    args,
                }
                await stream.writeSSE({
                    event: "tool-call",
                    data: JSON.stringify(event)
                })
            }


            if(chunk.type === "tool-result"){
                const resultStr = typeof chunk.output === "string" ? chunk.output : JSON.stringify(chunk.output);

                // Merge result into the tool-call part so DB reload has a single structured row.
                const tcPart = parts.find(
                    (p): p is Extract<MessagePart, { type: "tool-call" }> =>
                        p.type === "tool-call" && p.id === chunk.toolCallId
                );
                if(tcPart){
                    tcPart.result = resultStr;
                }

                const event: ChatStreamEvent = {
                    type: "tool-result",
                    toolCallId: chunk.toolCallId,
                    result: resultStr,
                }
                await stream.writeSSE({
                    event: "tool-result",
                    data: JSON.stringify(event)
                })
            }

            if(chunk.type === "error"){
                throw chunk.error;
            }
        }
        if(stream.aborted || abortController.signal.aborted ){
            await persistInterruptedMessage();
            return;
        }

        const elapsedMs = Date.now() - startTime;
        const fullText = parts
            .filter((p)=> p.type === "text")
            .map((p)=> p.text)
            .join("");

        const validateParts: Prisma.InputJsonValue | undefined = parts.length > 0 ? messagePartsSchema.parse(parts) : undefined;

        const assistantMessage = await db.message.create({
            data:{
                sessionId,
                role: "ASSISTANT",
                content: fullText,
                model,
                mode,
                status: MessageStatus.COMPLETE,
                parts: validateParts,
                // Message.duration is stored in whole seconds; SSE `done` uses milliseconds.
                duration: Math.round(elapsedMs/1000),
            }
        });

        const doneEvent: ChatStreamEvent = {
            type: "done",
            messageId: assistantMessage.id,
            durationMs:elapsedMs
        };
        await stream.writeSSE({
            event: "done",
            data: JSON.stringify(doneEvent)
        })
    }catch(err){
        if(abortController.signal.aborted){
            await persistInterruptedMessage();
            return;
        }
        const message = err instanceof Error ? err.message : "An unknown error occurred";
        // Persist provider failures so they appear in session history on reload.
        await db.message.create({
            data:{
                sessionId,
                role: "ERROR",
                content: message,
                model,
                mode,
                status: MessageStatus.COMPLETE,
            }
        });

        const errorEvent: ChatStreamEvent = {
            type: "error",
            message: message,
        }
        await stream.writeSSE({
            event: "error",
            data: JSON.stringify(errorEvent)
        })
    }
}

const app = new Hono<AuthenticatedEnv>()
    /** Resume generation for the last unanswered user message (no new USER row). */
    .post("/:sessionId/resume",async(c)=>{
        const sessionId  = c.req.param("sessionId");
        const userId = c.get("userId");
        const session = await db.session.findUnique({
            where: {
                id: sessionId,
                userId, // Must belong to the authenticated user
            },
            include: {
                messages: {
                    orderBy: {
                        createdAt: "asc",
                    },
                }
            },
        });
        if(!session){
            return c.json({ error: "Session not found" }, 404);
        }

        const resumableMessage = getResumableUserMessage(session.messages);
        if(!resumableMessage){
            return c.json({ error: "Session has no pending user message to resume" }, 409);
        }

        if(!isSupportedChatModel(resumableMessage.model)){
            return c.json({ error: `Session is using an unsupported model: ${resumableMessage.model}` }, 409);
        }

        if(activeResumeSessionIds.has(sessionId)){
            return c.json({ error: "Session is already being resumed" }, 409);
        }
        activeResumeSessionIds.add(sessionId);

        const history = buildConversationHistory(session.messages);
        const abortController = new AbortController();
        
        try{
            return streamSSE(
                c,
                async(stream)=>{
                    // Propagate client disconnect to the AI SDK so generation stops promptly.
                    stream.onAbort(()=>{
                        abortController.abort();
                    });
                    try{
                        await streamAIResponse(stream, {
                            sessionId,
                            model: resumableMessage.model,
                            cwd: session.cwd,
                            history,
                            mode: resumableMessage.mode,
                            abortController,
                        });
                    }finally{
                        activeResumeSessionIds.delete(sessionId);
                    }
                },
                async(err,stream) =>{
                    activeResumeSessionIds.delete(sessionId);

                    const message = err instanceof Error ? err.message : "An unknown error occurred";
                    const errorEvent: ChatStreamEvent = {
                        type: "error",
                        message,
                    }
                    await stream.writeSSE({
                        event: "error",
                        data: JSON.stringify(errorEvent)
                    });
                },
            );
        }catch(err){
            activeResumeSessionIds.delete(sessionId);
            throw err;
        }
    })
    /** Accept a user message, persist it, then stream the assistant reply. */
    .post("/:sessionId",submitValidator,async(c)=>{
        const sessionId  = c.req.param("sessionId");
        const userId = c.get("userId");

        const session = await db.session.findUnique({
            where: {
                id: sessionId,
                userId, // Must belong to the authenticated user
            },
            include: {
                messages: {
                    orderBy: {
                        createdAt: "asc",
                    },
                }
            },
        });
        if(!session){
            return c.json({ error: "Session not found" }, 404);
        }

        const data = c.req.valid("json");

        await db.message.create({
            data: {
                sessionId,
                role: "USER",
                content: data.content,
                model: data.model,
                mode: data.mode,
                status: MessageStatus.COMPLETE,
            }
        });

        // Include the just-created user turn when building SDK history.
        const history = buildConversationHistory([
            ...session.messages,
            {
                role: "USER" as const,
                content: data.content,
                status: MessageStatus.COMPLETE,
            }
        ]);


        const abortController = new AbortController();
        return streamSSE(
            c,
            async(stream)=>{
                // Propagate client disconnect to the AI SDK so generation stops promptly.
                stream.onAbort(()=>{
                    abortController.abort();
                });
                await streamAIResponse(stream, {
                    sessionId,
                    model: data.model,
                    cwd: session.cwd,
                    history,
                    mode: data.mode,
                    abortController,
                }); 
            },
            async(err,stream)=>{
                const message = err instanceof Error ? err.message : "An unknown error occurred";
                const errorEvent: ChatStreamEvent = {
                    type: "error",
                    message,
                }
                await stream.writeSSE({
                    event: "error",
                    data: JSON.stringify(errorEvent)
                }); 
            }
        );
    });


export default app;