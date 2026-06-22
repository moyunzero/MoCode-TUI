/**
 * Session-scoped prompt settings: agent mode (Build / Plan) and chat model.
 * Lives under RootLayout so InputBar, StatusBar, SessionShell, and slash commands
 * share one source of truth without prop drilling.
 */
import { createContext, useContext, useState, useCallback } from "react";
import type { ReactNode } from "react";
import { DEFAULT_CHAT_MODEL_ID, type SupportedChatModelId } from "@mocode/shared";
import { Mode, type ModeType } from "@mocode/shared";

type PromptConfigContextValue = {
    /** Active agent mode; drives border color, spinner tint, and API request shape. */
    mode:ModeType;
    /** Flip between BUILD and PLAN (bound to Tab in InputBar). */
    toggleMode: () => void;
    setMode: (mode:ModeType) => void;
    /** LLM id sent with each chat request; shown in StatusBar. */
    model:SupportedChatModelId;
    setModel: (model:SupportedChatModelId) => void;
}

const PromptConfigContext = createContext<PromptConfigContextValue | null>(null);

export function usePromptConfig(): PromptConfigContextValue {
    const value = useContext(PromptConfigContext);
    if(!value){
        throw new Error("usePromptConfig must be used within a PromptConfigProvider");
    }
    return value;
}

type PromptConfigProviderProps = {
    children: ReactNode;
}

export function PromptConfigProvider(
    {children}: PromptConfigProviderProps
){
    const [mode,setMode] = useState<ModeType>(Mode.BUILD);
    const [model,setModel] = useState<SupportedChatModelId>(DEFAULT_CHAT_MODEL_ID);

    const toggleMode = useCallback(()=>{
        setMode((prev)=> (prev === Mode.BUILD ? Mode.PLAN : Mode.BUILD));
    },[]);

    return(
        <PromptConfigContext.Provider 
            value={{
                mode,
                toggleMode,
                setMode,
                model,
                setModel,
            }}>
            {children}
        </PromptConfigContext.Provider>
    );

}