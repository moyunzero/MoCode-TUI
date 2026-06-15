import { Outlet } from "react-router";
import { ThemeRoot } from "./theme-root";
import { ToastProvider } from "../providers/toast";
import { DialogProvider } from "../providers/dialog";
import { KeyboardLayerProvider } from "../providers/keyboard-layer";
import { ThemeProvider } from "../providers/theme";

export function RootLayout(){
    return (
        <ThemeProvider>
            <ToastProvider>
                <KeyboardLayerProvider>
                    <DialogProvider>
                        <ThemeRoot>
                            <Outlet />
                        </ThemeRoot>
                    </DialogProvider>
                </KeyboardLayerProvider>
            </ToastProvider>
        </ThemeProvider>
    );
}