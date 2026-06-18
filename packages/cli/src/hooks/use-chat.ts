/**
 * Client-side chat state for a single session.
 *
 * Owns the message list, live streaming buffer, and lifecycle of in-flight SSE
 * requests. Each stream is keyed by a `requestId` so stale responses from
 * aborted or superseded requests are ignored safely.
 */
import { useState, useRef, useCallback, useEffect } from "react";
import { EventSourceParserStream } from "eventsource-parser/stream";
import prettyMs from "pretty-ms";
import { apiClient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";
import type { ClientResponse } from "hono/client";
import type { Mode } from "@mocode/database/enums";
import {
    chatStreamEventSchema,
    type SupportedChatModelId
} from "@mocode/shared";

/** Minimal part shape rendered by {@link BotMessage}; text-only for now. */
export type ClientMessagePart = { type: "text"; text:string };

/** Discriminated union of all messages shown in the session transcript. */
export type Message = 
    | {
        id: string;
        role: "user";
        content: string;
        mode:Mode;
        model: SupportedChatModelId;
    }
    |{
        id: string;
        role: "assistant";
        content: string;
        mode:Mode;
        model: SupportedChatModelId;
        parts: ClientMessagePart[];
        duration?:string;
        interrupted?: boolean;
    }
    |{
        id: string;
        role: "error";
        content: string;
    }

/** Ephemeral UI state while tokens are arriving; cleared when the stream ends. */
type StreamingState = 
|{
    status: "idle";
}
|{
    status: "streaming";
    parts: ClientMessagePart[];
    mode:Mode;
    model: SupportedChatModelId;
};

/** Mutable ref payload for the single in-flight stream (at most one per hook). */
type ActiveStream = {
    /** Correlates async work; mismatched ids are dropped to avoid races. */
    requestId: string;
    controller: AbortController;
    mode :Mode,
    model: SupportedChatModelId,
    parts: ClientMessagePart[];
    /** Guards against persisting the same partial reply twice on interrupt. */
    interruptedCaptured: boolean;
}

type SubmitParams = {
    userText: string;
    mode: Mode;
    model: SupportedChatModelId;
}

type RunStreamParams = {
    mode:Mode;
    model: SupportedChatModelId;
    /** Factory so submit/resume can target different endpoints with shared plumbing. */
    request: (controller: AbortController) => Promise<ClientResponse<unknown>>;
}

/**
 * @param sessionId - Persisted session used for chat API paths.
 * @param initialMessages - Hydrated DB history; also drives auto-resume when the
 *   last row is an unanswered user message (e.g. after a crash mid-stream).
 */
export function useChat(
    sessionId: string,
    initialMessages: Message[],
){
    const [messages,setMessages] = useState<Message[]>(initialMessages);
    const [streaming,setStreaming] = useState<StreamingState>({ status: "idle" });
    
  // Ref holds the in-flight stream for synchronous guards; `streaming` state drives UI only.
    const activeStreamRef = useRef<ActiveStream | null>(null);
    
    const updateMessage = useCallback((
        updater:(prev:Message[]) => Message[]
    )=>{
        setMessages(prev=>{
            const newMessages = updater(prev);
            return newMessages;
        });
    },[])

    /** Drops stale async work when a newer stream supersedes or aborts this requestId. */
    const isActiveRequest = useCallback((
        requestId: string,
    )=>{
        return activeStreamRef.current?.requestId === requestId;
    },[]);

    /** Pushes the latest token buffer into React state for the live BotMessage row. */
    const emitParts = useCallback((
        requestId: string,
        parts: ClientMessagePart[],
    )=>{
        if(!isActiveRequest(requestId)){
            return;
        }
        const snapshot = [...parts];
        const activeStream = activeStreamRef.current;
        if(!activeStream) return;

        activeStream.parts = snapshot;
        setStreaming({
            status: "streaming",
            parts: snapshot,
            mode: activeStream.mode,
            model: activeStream.model,
        });
    },[isActiveRequest]);

    /**
     * Commits partial assistant output when the user interrupts or submits
     * while streaming. Client-side mirror of server INTERRUPTED rows; server
     * also persists when the SSE connection drops before `done`.
     */
    const captureInterruptedMessage = useCallback((
        activeStream: ActiveStream
    )=>{
        if(
            activeStream.interruptedCaptured ||
            activeStream.parts.length === 0
        ){
            return;
        }

        activeStream.interruptedCaptured = true;
        const parts = [...activeStream.parts];
        const fullText = parts
            .filter((p)=> p.type === "text")
            .map((p)=> p.text)
            .join("");
        
        updateMessage((prev)=>[
            ...prev,
            {
                id:crypto.randomUUID(),
                role: "assistant",
                content: fullText,
                mode: activeStream.mode,
                model: activeStream.model,
                parts,
                interrupted: true,
            }
        ]);

    },[updateMessage])

    /** Clears ref + streaming UI after a stream finishes, errors, or is aborted. */
    const clearStream = useCallback(
        (requestId: string)=>{
            if(!isActiveRequest(requestId)){
                return;
            }
            activeStreamRef.current = null;
            setStreaming({ status: "idle" });
        },[isActiveRequest]
    );

    /**
     * Parses SSE frames from the Hono client response and maps them to transcript
     * updates. Coalesces adjacent `text-delta` events into a single text part.
     */
    const handleStream = useCallback(async(
        response: ClientResponse<unknown>,
        activeStream: ActiveStream
    )=>{
        if(!isActiveRequest(activeStream.requestId)) return;

        if(!response.ok){
            const message = await getErrorMessage(response);
            updateMessage((prev)=>[
                ...prev,
                {
                    id:crypto.randomUUID(),
                    role: "error",
                    content: message,
                }
            ]);
            return;
        }
        const parts: ClientMessagePart[] = [];

        // Hono returns a byte stream; decode to text, then parse SSE `data:` frames.
        const stream = response
            .body!.pipeThrough(new TextDecoderStream())
            .pipeThrough(new EventSourceParserStream())
            
        for await ( const {data} of stream ){
            if(!isActiveRequest(activeStream.requestId)) return;

            try{
                const event = chatStreamEventSchema.parse(JSON.parse(data));

                switch (event.type){
                    case "text-delta":{
                        // Merge consecutive deltas into one part to reduce re-renders.
                        const last = parts[parts.length - 1];
                        if(last && last.type === "text"){
                            last.text += event.text;
                        }else{
                            parts.push({ type: "text", text: event.text });
                        }
                        emitParts(activeStream.requestId, parts);
                        break;
                    }
                    case "done":{
                        // Finalize assistant message using server-assigned id and timing.
                        if(!isActiveRequest(activeStream.requestId)) return;

                        const fullText = parts
                            .filter((p)=> p.type === "text")
                            .map((p)=> p.text)
                            .join("");

                        updateMessage((prev)=>[
                            ...prev,
                            {
                                id: event.messageId,
                                role: "assistant",
                                content: fullText,
                                mode: activeStream.mode,
                                model: activeStream.model,
                                duration: prettyMs(event.durationMs),
                                parts: [...parts],
                            }
                        ]);
                        break;
                    }
                    case "error":{
                        // Server persisted ERROR row; surface message in the transcript.
                        updateMessage((prev)=>[
                            ...prev,
                            {
                                id:crypto.randomUUID(),
                                role: "error",
                                content: event.message,
                            }
                        ]);
                        break;
                    }
                }
            }catch(err){
                const message = err instanceof Error ?err.message : "Invalid stream event";
                updateMessage((prev)=>[
                    ...prev,
                    {
                        id:crypto.randomUUID(),
                        role: "error",
                        content: message,
                    }
                ]);
                break;
            }
        }
    },[updateMessage, emitParts, isActiveRequest]);

    /** Starts one SSE request: registers active stream, handles errors, always clears. */
    const runstream = useCallback(async(
       { mode, model, request }: RunStreamParams
    )=>{
        const controller = new AbortController();
        const acticeStream: ActiveStream = {
            requestId: crypto.randomUUID(),
            controller,
            mode,
            model,
            parts: [],
            interruptedCaptured: false,
        };
        activeStreamRef.current = acticeStream;
        setStreaming({ status: "streaming", mode, model, parts: [] });
        try{
            const response = await request(controller);
            await handleStream(response, acticeStream);
        }catch(err){
           // User abort/interrupt is intentional; do not append an error message.
           if(err instanceof DOMException && err.name === "AbortError"){
            return;
           }

           if(!isActiveRequest(acticeStream.requestId)) return;

           const message = err instanceof Error ? err.message : "An unknown error occurred";
           updateMessage((prev)=>[
            ...prev,
            {
                id:crypto.randomUUID(),
                role: "error",
                content: message,
            } 
           ]);
        } finally{
            clearStream(acticeStream.requestId);
        }
       
    },[handleStream, updateMessage, isActiveRequest, clearStream]);

    /**
     * Aborts the in-flight fetch. When `capturePartial` is true, partial text
     * is appended to `messages` before abort (interrupt / new submit).
     *
     * Pairs with server `stream.onAbort` → `persistInterruptedMessage` when the
     * connection drops before a `done` event.
     */
    const stopActiveStream = useCallback((
        capturePartial: boolean
    )=>{
        const activeStream = activeStreamRef.current;
        if(!activeStream) return;
        if(capturePartial){
            captureInterruptedMessage(activeStream);
        }
        activeStreamRef.current = null;
        setStreaming({ status: "idle" });
        activeStream.controller.abort();
    },[captureInterruptedMessage])

    /** Replays the last user turn against POST /chat/:sessionId/resume (no new user row). */
    const resume = useCallback(async(
        {mode,model} : Omit<SubmitParams, "userText">
    )=>{
        await runstream({
            mode,
            model,
            request: async(controller)=>{
                return apiClient.chat[":sessionId"].resume.$post(
                    {
                        param: {
                            sessionId,
                        },
                    },
                    {
                        init: {
                            signal: controller.signal,
                        },
                    }
                );
            },
        });
    }, [runstream, sessionId]);

    // Fire once on mount when history ends with an unanswered user message.
    const hasAutoResumedRef = useRef(false);
    useEffect(()=>{
        if(hasAutoResumedRef.current) return;
        const last = initialMessages[initialMessages.length - 1];
        if(!last || last.role !== "user") return;

        hasAutoResumedRef.current = true;
        void resume({ mode: last.mode, model: last.model });
    }, [initialMessages, resume]);

    /** Appends a user row, then opens SSE to POST /chat/:sessionId. */
    const submit = useCallback(async(
        { userText, mode, model }: SubmitParams
    )=>{
        // Interrupt any in-flight reply and keep its partial text before starting a new turn.
        stopActiveStream(true);
        const userMessage: Message = {
            id:crypto.randomUUID(),
            role: "user",
            content: userText,
            mode,
            model,
        };
        updateMessage((prev)=>[
            ...prev,
            userMessage,
        ]);
        await runstream({
            mode,
            model,
            request: async(controller)=>{
                return apiClient.chat[":sessionId"].$post(
                    {
                        param: {
                            sessionId,
                        },
                        json: {
                            content: userText,
                            mode,
                            model,
                        },
                    },
                    {
                        init:{
                            signal: controller.signal,
                        }
                    }
                )
            }
        });
    }, [updateMessage, runstream, sessionId, stopActiveStream]);

    /** Drops the stream without keeping partial text (e.g. unmount cleanup). */
    const abort = useCallback(()=>{
        stopActiveStream(false);
    }, [stopActiveStream]);

    /** User-facing interrupt (Esc): keep partial assistant text in the transcript. */
    const interrupt = useCallback(()=>{
        stopActiveStream(true);
    }, [stopActiveStream]);

    return {
        messages,
        streaming,
        submit,
        abort,
        interrupt,
    };
  
}