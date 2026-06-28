import { Outlet } from "react-router";
import { ThemeRoot } from "./theme-root";
import { ToastProvider } from "../providers/toast";
import { DialogProvider } from "../providers/dialog";
import { KeyboardLayerProvider } from "../providers/keyboard-layer";
import { ThemeProvider } from "../providers/theme";
import { PromptConfigProvider } from "../providers/prompt-config";
import { KeysSetupGate } from "../components/keys-setup-gate";

/**
 * Provider stack for the CLI shell.
 * PromptConfig sits inside DialogProvider so slash commands can open pickers
 * that read/write shared mode and model state.
 */
export function RootLayout(){
    return (
        <ThemeProvider>
            <ToastProvider>
                <KeyboardLayerProvider>
                    <DialogProvider>
                        <KeysSetupGate />
                        <PromptConfigProvider>
                            <ThemeRoot>
                                <Outlet />
                            </ThemeRoot>
                        </PromptConfigProvider>
                    </DialogProvider>
                </KeyboardLayerProvider>
            </ToastProvider>
        </ThemeProvider>
    );
}