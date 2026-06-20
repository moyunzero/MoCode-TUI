import { useCallback, useEffect, useState } from "react";
import { TextAttributes } from "@opentui/core";
import { format } from "date-fns";
import { useNavigate } from "react-router";
import { useDialog } from "../../providers/dialog";
import { useToast } from "../../providers/toast";
import { apiClient } from "../../lib/api-client";
import { getErrorMessage } from "../../lib/http-errors";
import { DialogSearchList } from "../dialog-search-list";
import type { InferResponseType } from "hono/client";

type Session = InferResponseType<(typeof apiClient.sessions)["$get"], 200>[number];

/**
 * Fetches the user's session list on mount and opens the chosen session on Enter.
 * Opened by `/sessions`; navigates to `/sessions/:id` after selection.
 */
export const SessionDialogContent = ()=>{
    const [sessions, setSessions] = useState<Session[]>([]);
    const [loading, setLoading] = useState(false);
    const { close } = useDialog();
    const navigate = useNavigate();
    const { show } = useToast();

    // Load sessions once when the dialog opens; ignore stale responses after unmount.
    useEffect(()=>{
        let ignore = false;
        const fetchSessions = async ()=>{
            if(!ignore) setLoading(true);
            try{
                const response = await apiClient.sessions.$get();
               
                if(!response.ok) throw new Error(await getErrorMessage(response));
                const data = await response.json();
                if(!ignore) {
                    setSessions(data);
                }
            }catch(error){
                if(!ignore) {
                    show({
                        variant: "error",
                        message: error instanceof Error ? error.message : "Failed to fetch sessions",
                    });
                    // Dismiss the dialog so the user isn't stuck on an empty list.
                    close()
                }
            } finally {
                if(!ignore) setLoading(false);
            }
        };
        fetchSessions();
        return ()=>{
            ignore = true;
        };
    },[close,show]);

    const handleSelect = useCallback(
        (session:Session)=>{
            close();
            navigate(`/sessions/${session.id}`);
    },[navigate,close]);

    if(loading){
        return(
            <box flexDirection="column">
                <text
                    attributes={TextAttributes.DIM}
                >
                    Loading sessions...
                </text>
            </box>
        )
    }

    return(
        <DialogSearchList
            items={sessions}
            onSelect={handleSelect}
            filterFn={(session,query)=>session.title.toLowerCase().includes(query.toLowerCase())}
            renderItem={(session,isSelected)=>(
                <>
                    <text
                        selectable={false}
                        fg={isSelected? "black" : "white"}
                    >
                        {session.title}
                    </text>
                    <box flexGrow={1} />
                    {/* Created-at is secondary metadata, right-aligned via flexGrow spacer. */}
                    <text
                        selectable={false}
                        attributes={TextAttributes.DIM}
                        fg={isSelected? "black" : undefined}
                    >
                        {format(new Date(session.createdAt), "hh:mm a")}
                    </text>
                </>
                
            )}
            getKey={(session)=>session.id}
            placeholder="Search sessions..."
            emptyText="No sessions found"
        />
    )

}