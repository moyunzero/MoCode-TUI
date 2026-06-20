import { SessionShell } from "../components/session-shell";
import { useState,useEffect, useMemo } from "react";
import { useParams,useLocation,useNavigate } from "react-router";
import { z } from "zod";
import prettyMs from "pretty-ms";
import type {  InferResponseType } from "hono/client";
import {
    UserMessage,
    BotMessage,
    ErrorMessage,
} from "../components/messages";
import { apiClient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";
import { useToast } from "../providers/toast"; 
import { messagePartsSchema, type SupportedChatModelId } from "@mocode/shared";
import { useChat } from "../hooks/use-chat";
import type { Message,ClientMessagePart } from "../hooks/use-chat";
import { useKeyboard} from "@opentui/react";
import { MessageStatus } from "@mocode/database/enums";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { usePromptConfig } from "../providers/prompt-config";


type SessionData = InferResponseType<(typeof apiClient.sessions)[":id"]["$get"], 200>;

/** Optional session payload from navigation state after session creation. */
const sessionLocationSchema = z.object({
    session: z.custom<SessionData>((value) => value != null && typeof value === "object" && "id" in value),
});

/** Maps persisted DB rows into {@link useChat} message shape (incl. interrupted flag). */
function mapDbMessages(dbMessages:SessionData["messages"]):Message[]{
    return dbMessages.map((msg)=>{
        if(msg.role === "ERROR"){
            return{
                id: msg.id,
                role: "error",
                content: msg.content,
            }
        }

        if(msg.role === "USER"){
            return{
                id: msg.id,
                role: "user",
                content: msg.content,
                mode: msg.mode,
                model: msg.model as SupportedChatModelId,
            }
        }

        // Hydrate Message.parts from JSON; add client-only status for tool-call rows.
        const parsedParts =msg.parts===null ? null : messagePartsSchema.safeParse(msg.parts);
        const parts: ClientMessagePart[] = parsedParts?.success ? parsedParts.data.map((p)=>
            p.type === "tool-call" ? {...p,status:"done" as const} : p
        ) : [];

        return{
            id: msg.id,
            role: "assistant",
            content: msg.content,
            mode: msg.mode,
            model: msg.model as SupportedChatModelId,
            parts,
            ...(msg.duration !=null ? {
                // DB stores duration in seconds; prettyMs expects milliseconds.
                duration: prettyMs(msg.duration * 1000)
            } : {}),
            interrupted: msg.status === MessageStatus.INTERRUPTED,
        };
    });
}

function ChatMessage({ msg }: { msg: Message }) {
    // Thin role switch; streaming rows are rendered separately in SessionChat.
    if (msg.role === "user") {
        return <UserMessage message={msg.content} mode={msg.mode} />;
    }
    if (msg.role === "error") {
        return <ErrorMessage message={msg.content} />;
    }
   return (
    <BotMessage
        parts={msg.parts}
        model={msg.model}
        mode={msg.mode}
        duration={msg.duration}
        streaming = {false}
        interrupted={msg.interrupted}
    />
   )
};

/** Wired session view: hydrates history, streams new turns, handles Esc interrupt. */
function SessionChat(
    { session }: { session: SessionData },
){
    // Snapshot DB history once; later turns come from useChat state, not re-fetched props.
    const [initialMessages] = useState(()=>mapDbMessages(session.messages));
    const { messages, streaming, submit, abort, interrupt } = useChat(session.id, initialMessages);
    const { isTopLayer } = useKeyboardLayer();
    const { mode, model } = usePromptConfig();

    // Abort in-flight SSE when leaving the screen so we do not leak fetch work.
    useEffect(()=>{
        return ()=>{
            abort();
        };
    },[abort]);

    // Esc interrupts only on the base layer so modals keep priority.
    useKeyboard((key)=>{
        if(key.name === "escape" && isTopLayer("base") && streaming.status === "streaming"){
            key.preventDefault();
            interrupt();
        }
    })

    return(
        <SessionShell
            onSubmit={(text)=>{
                submit({
                    userText: text,
                    mode,
                    model,
                })
            }}
            loading = {streaming.status === "streaming"}
            interruptible = {streaming.status === "streaming"}
        >
            {
                messages.map((msg)=>(
                    <ChatMessage key={msg.id} msg={msg} />
                ))
            }
            {/* Ephemeral row: not in `messages` until `done` or interrupt. */}
            {
                streaming.status === "streaming" && streaming.parts.length > 0 &&(
                    <BotMessage
                        parts={streaming.parts}
                        model={streaming.model}
                        mode={streaming.mode}
                        streaming
                    />
                )
            }
        </SessionShell>
    )
}

export function Session(){
    const { id } = useParams();
    const location = useLocation();
    const navigate = useNavigate();
    const toast = useToast();

    const prefetched = useMemo(() => {
        const parsed = sessionLocationSchema.safeParse(location.state);
        return parsed.success ? parsed.data.session : null;
    }, [location.state]);

    const [session, setSession] = useState<SessionData | null>(prefetched);

    useEffect(() => {
        // Skip fetch when we already have session data from the create flow.
        if (prefetched) return;
        setSession(null);
        if(!id) return;
        let ignore = false;
        const fetchSession = async ()=>{
            try{
                const response = await apiClient.sessions[":id"].$get({
                    param: { id },
                });
                if(ignore) return;
                if(!response.ok) throw new Error(await getErrorMessage(response));

                const resolved  = await response.json();
                setSession(resolved);
            }catch(error){
                if(ignore) return;
                toast.show({
                    variant:"error",
                    message: error instanceof Error ? error.message : "Failed to fetch session",
                });
                navigate("/", { replace: true });
            }
        }
        fetchSession();
        return ()=>{
            ignore = true;
        };
    },[id,prefetched,navigate,toast]);

    if(!session) {
        return <SessionShell onSubmit={()=>{}} inputDisabled loading />;
    }


    // `key` remounts useChat when navigating between sessions.
    return <SessionChat  key={session.id} session={session} />;
}