/**
 * Chat HTTP routes: submit a user turn and stream the assistant reply via SSE.
 *
 * Persists USER / ASSISTANT / ERROR rows to the database. Interrupted streams
 * (client disconnect or abort) save partial ASSISTANT content with INTERRUPTED
 * status. Resume replays generation when the last stored message is USER-only.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import { streamText as aiStreamText } from "ai";
import { db } from "@mocode/database/client";
import { Mode, MessageStatus } from "@mocode/database/enums";
import { type ChatStreamEvent } from "@mocode/shared";
import { isSupportedChatModel, resolveChatModel } from "../lib/model";


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
    history: {
        role: "user" | "assistant";
        content: string;
    }[];
    mode: Mode;
    abortController: AbortController;
}  

/**
 * Runs `streamText`, forwards `text-delta` chunks as SSE, then persists the
 * final assistant row or handles abort/error paths.
 */
async function streamAIResponse(
    stream:Parameters<Parameters<typeof streamSSE>[1]>[0],
    params: StreamParams
){
    const { sessionId, model, history, mode, abortController } = params;

    const startTime = Date.now();
    const resolvedModel = resolveChatModel(model);
    let fullText = "";

    /** Writes partial output when the client disconnects before `done`. */
    const persistInterruptedMessage = async ()=>{
        if(fullText.length === 0 ) return;

        const elapsedMs = Date.now() - startTime;

        await db.message.create({
            data:{
                sessionId,
                role: "ASSISTANT",
                status:MessageStatus.INTERRUPTED,
                content: fullText,
                model,
                mode,
                duration: Math.round(elapsedMs/1000), // seconds in DB; see `done.durationMs` on wire
            }
        })
    }
    
    try{
        const result = aiStreamText({
            model: resolvedModel.model,
            messages:history,
            abortSignal: abortController.signal,
        });
        
        for await (const chunk of result.fullStream){
            if(stream.aborted) break;
            if(chunk.type === "text-delta"){
                fullText += chunk.text;
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
            if(chunk.type === "error"){
                throw chunk.error;
            }
        }
        if(stream.aborted || abortController.signal.aborted ){
            await persistInterruptedMessage();
            return;
        }

        const elapsedMs = Date.now() - startTime;
        const assistantMessage = await db.message.create({
            data:{
                sessionId,
                role: "ASSISTANT",
                content: fullText,
                model,
                mode,
                status: MessageStatus.COMPLETE,
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

const app = new Hono()
    /** Resume generation for the last unanswered user message (no new USER row). */
    .post("/:sessionId/resume",async(c)=>{
        const sessionId  = c.req.param("sessionId");
        const session = await db.session.findUnique({
            where: {
                id: sessionId,
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
        
        const session = await db.session.findUnique({
            where: {
                id: sessionId,
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