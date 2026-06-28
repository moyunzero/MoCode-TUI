import { useEffect, useMemo, useRef } from "react";
import { useNavigate,useLocation } from "react-router";
import { UserMessage } from "../components/messages";
import { SessionShell } from "../components/session-shell";
import { z } from "zod";
import { useToast } from "../providers/toast";
import { useDialog } from "../providers/dialog";
import { apiClient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";
import { findSupportedChatModel, Mode, modeSchema } from "@mocode/shared";
import { isLocalMode } from "../lib/local-mode";
import { createLocalSession } from "../lib/local-sessions";
import { hasRequiredKeys } from "../lib/keys";
import { openKeysWizardIfNeeded } from "../lib/keys-wizard-trigger";

/** Router state passed from the home screen when the user submits a prompt. */
const newSessionStateSchema = z.object({
    message: z.string(),
    mode: modeSchema,
    model: z.string(),
});

export function NewSession() {
    const navigate = useNavigate();
    const location = useLocation();
    const toast = useToast();
    const dialog = useDialog();
    // Prevent double POST when React Strict Mode re-runs effects in development.
    const hasStartedRef = useRef(false);

    const state = useMemo(() => {
        const parsed = newSessionStateSchema.safeParse(location.state);
        return parsed.success ? parsed.data : null;
    },[location.state]);

    useEffect(() => {
        if (!state) {
            navigate("/", { replace: true });
        }
    }, [state, navigate]);

    useEffect(()=>{
        if(!state || hasStartedRef.current) return;
        hasStartedRef.current = true;
        
        let ignore = false;
        const createSession = async () => {
            try{
                if (isLocalMode()) {
                    const model = findSupportedChatModel(state.model);
                    if (!model) {
                        throw new Error(`Unsupported chat model: ${state.model}`);
                    }
                    const provider = model.provider;
                    if (!hasRequiredKeys(provider)) {
                        openKeysWizardIfNeeded(dialog, { provider });
                        if (ignore) return;
                        navigate("/", { replace: true });
                        return;
                    }
                    const session = createLocalSession(state.message.slice(0, 100));
                    if (ignore) return;
                    navigate(`/sessions/${session.id}`, {
                        replace: true,
                        state: { session, initialPrompt: state, local: true },
                    });
                    return;
                }

                const response = await apiClient.sessions.$post({
                    json:{
                        title:state.message.slice(0,100),
                    },
                });
                if(ignore) return;
                if(!response.ok) throw new Error(await getErrorMessage(response));
                const session = await response.json();
                // Pass the created session via router state to avoid an immediate refetch.
                navigate(`/sessions/${session.id}`, { replace: true, state: { session, initialPrompt: state } });
            }catch(error){
                if(ignore) return;
                toast.show({
                    variant:"error",
                    message: error instanceof Error ? error.message : "Failed to create session",
                });
                navigate("/", { replace: true });
            }
        };
        createSession();
        return ()=>{
            ignore = true;
        };
    },[state,navigate,toast,dialog]);


    if(!state) return null;
    return (
        <SessionShell 
            onSubmit={()=>{}} 
            inputDisabled 
            loading
        >
            <UserMessage 
                message={state.message} 
                mode={state.mode} 
            />
        </SessionShell>
    )
}