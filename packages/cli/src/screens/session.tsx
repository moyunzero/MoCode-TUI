import { SessionShell } from "../components/session-shell";
import { useState,useEffect, useMemo } from "react";
import { useParams,useLocation,useNavigate } from "react-router";
import { z } from "zod";
import type {  InferResponseType } from "hono/client";
import {
    UserMessage,
    BotMessage,
    ErrorMessage,
} from "../components/messages";
import { apiClient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";
import { useToast } from "../providers/toast"; 

type SessionData = InferResponseType<(typeof apiClient.sessions)[":id"]["$get"], 200>;

/** Optional session payload from navigation state after session creation. */
const sessionLocationSchema = z.object({
    session:z.custom<SessionData>((value)=> value != null&& typeof value === "object" && "id" in value )
})

function ChatMessage(
    { msg }: {
        msg: SessionData["messages"][number];
    }
){

    if(msg.role === "USER"){
        return <UserMessage message={msg.content} />;
    }
    if(msg.role === "ERROR"){
        return <ErrorMessage message={msg.content} />;
    }
    
    return <BotMessage content={msg.content} model={msg.model} />;
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


    return (
       <SessionShell onSubmit={()=>{}} inputDisabled >
        {session.messages.map((msg)=>(
            <ChatMessage key={msg.id} msg={msg} />
        ))}
       </SessionShell>
    )
}