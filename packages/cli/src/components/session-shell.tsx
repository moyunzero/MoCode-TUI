import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { InputBar } from "./input-bar";
import { Spinner } from "./spinner";

/** Session layout: scrollable transcript, input bar, and status footer. */
type Props = {
    children?: ReactNode;
    onSubmit : (text: string) => void;
    inputDisabled?: boolean;
    /** Shows spinner in the footer while the assistant is streaming. */
    loading?: boolean;
    /** When true with loading, shows "esc to interrupt" hint. */
    interruptible?: boolean;
}

export function SessionShell({ 
    children, 
    onSubmit, 
    inputDisabled = false, 
    loading = false ,
    interruptible = false,
}: Props){
    return (
        <box 
            width="100%" 
            height="100%" 
            flexDirection="column"
            gap={1}
            flexGrow={1}
            paddingY={1}
            paddingX={2}
        >
            <scrollbox
                flexGrow={1}
                width="100%"
                stickyScroll
                stickyStart="bottom"
            >
                {/* Keep the latest message in view as the transcript grows. */}
                <box gap={1}>
                    {children}
                </box>
            </scrollbox>
            <box flexShrink={0}>
                <InputBar onSubmit={onSubmit} disabled={inputDisabled} />
            </box>
            <box
                flexShrink={0}
                flexDirection="row"
                justifyContent="space-between"
                width="100%"
                height={1}
                gap={2}
                paddingLeft={1}
            >
                <box
                    flexDirection="row"
                    alignItems="center"
                    gap={2}
                >
                    {loading ? (
                        <>
                            <Spinner />
                            {interruptible ?<text>esc to interrupt</text>:null}
                        </>
                    ):null}
                </box>
                <box
                    flexDirection="row"
                    gap={1}
                    flexShrink={0}
                    marginLeft="auto"
                >
                    {/* TODO: Add tab navigation */}
                    <text>tab</text>
                    <text attributes={TextAttributes.DIM}>agent</text>
                </box>
            </box>
        </box>
    );
}