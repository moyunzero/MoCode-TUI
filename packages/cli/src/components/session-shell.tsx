import { TextAttributes } from "@opentui/core";
import type { ReactNode } from "react";
import { InputBar } from "./input-bar";
import { Spinner } from "./spinner";

type Props = {
    children?: ReactNode;
    onSubmit : (text: string) => void;
    inputDisabled?: boolean;
    loading?: boolean;
}

export function SessionShell({ 
    children, 
    onSubmit, 
    inputDisabled = false, 
    loading = false 
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
                    {loading ? 
                        <Spinner />:null
                    }
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