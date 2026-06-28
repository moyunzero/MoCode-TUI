/** Modal overlay provider; pushes a "dialog" keyboard layer while open. */
import { createContext, useContext, useState, useCallback, useRef, useMemo } from "react";
import type { ReactNode } from "react";
import { TextAttributes,RGBA } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { DialogConfig } from "./types";
import { useKeyboardLayer } from "../keyboard-layer";
import { useTheme } from "../theme";

export type DialogContextValue = {
    open:(config:DialogConfig)=>void;
    close:()=>void;
}

const DialogContext = createContext<DialogContextValue | null>(null);

export function useDialog(): DialogContextValue {
    const value = useContext(DialogContext);
    if(!value) {
        throw new Error("useDialog must be used within a DialogProvider");
    }
    return value;
}

type DialogProviderProps = {
    children: ReactNode;
}

export function DialogProvider({ children }: DialogProviderProps) {
    const [currentDialog,setCurrentDialog] = useState<DialogConfig | null>(null);
    const currentDialogRef = useRef<DialogConfig | null>(null);
    const { push, pop } = useKeyboardLayer();

    const close = useCallback(()=>{
        const dialog = currentDialogRef.current;
        currentDialogRef.current = null;
        setCurrentDialog(null);
        dialog?.onClose?.();
        pop("dialog");
    },[pop]);

    const open = useCallback((config:DialogConfig)=>{
        if (currentDialogRef.current) {
            const previous = currentDialogRef.current;
            currentDialogRef.current = null;
            setCurrentDialog(null);
            previous.onClose?.();
            pop("dialog");
        }
        currentDialogRef.current = config;
        setCurrentDialog(config);
        // Ctrl+C on a dialog dismisses it instead of quitting the app.
        push("dialog",()=>{
            close();
            return true;
        });
    },[close,pop]);

    const value: DialogContextValue = useMemo(
        () => ({
            open,
            close,
        }),
        [open, close],
    );
    return(
        <DialogContext.Provider value={value}>
            {children}
            <Dialog 
                currentDialog={currentDialog} 
                close={close} 
            />
        </DialogContext.Provider>
    );
};

type DialogProps = {
    currentDialog: DialogConfig | null;
    close: () => void;
}

function Dialog({ currentDialog, close }: DialogProps) {
    const { isTopLayer } = useKeyboardLayer();
    const dimensions = useTerminalDimensions();
    const { colors } = useTheme();

    useKeyboard((key)=>{
        if(!currentDialog || !isTopLayer("dialog")) return;
        if(key.name === "escape") {
            // key.preventDefault();
            close();
        }
    })
    if(!currentDialog) return null;
    const { title, children } = currentDialog;
    return(
        <box
            position="absolute"
            justifyContent="center"
            top={0}
            left={0}
            width={dimensions.width }
            height={dimensions.height }
            alignItems="center"
            backgroundColor={RGBA.fromInts(0,0,0,150)}
            zIndex={100}
            onMouseDown={()=>close()}
        >
            <box
                width={Math.min(72,dimensions.width - 4)}
                height="auto"
                backgroundColor={colors.dialogSurface}
                paddingX={4}
                paddingY={1}
                flexDirection="column"
                gap={1}
                onMouseDown={(e)=>e.stopPropagation()}
            >
                <box
                    paddingBottom={1}
                    flexDirection="row"
                    alignItems="center"
                    justifyContent="space-between"
                >
                    <text attributes={TextAttributes.BOLD} >
                        {title}
                    </text>
                    <text
                        attributes={TextAttributes.DIM}
                        onMouseDown={()=>close()}
                    >
                        esc
                    </text>
                </box>
                <box flexGrow={1}>
                    {children}
                </box>
            </box>
        </box>
    );
}