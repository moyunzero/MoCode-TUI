import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import type { ReactNode, RefObject } from "react";
import { InputBar } from "./input-bar";
import { Spinner } from "./spinner";
import { usePromptConfig } from "../providers/prompt-config";

/** Session layout: scrollable transcript, input bar, and status footer. */
type Props = {
    children?: ReactNode;
    onSubmit : (text: string) => void;
    inputDisabled?: boolean;
    /** Shows spinner in the footer while the assistant is streaming. */
    loading?: boolean;
    /** When true with loading, shows "esc to interrupt" hint. */
    interruptible?: boolean;
    /** While a Task subagent runs — shows type in footer (D-21). */
    subagentRunning?: boolean;
    subagentType?: string | null;
    composerRestoreText?: string | null;
    composerRestoreToken?: number;
    transcriptScrollRef?: RefObject<ScrollBoxRenderable | null>;
}

export function SessionShell({ 
    children, 
    onSubmit, 
    inputDisabled = false, 
    loading = false ,
    interruptible = false,
    subagentRunning = false,
    subagentType = null,
    composerRestoreText = null,
    composerRestoreToken = 0,
    transcriptScrollRef,
}: Props){

    // Footer spinner reads mode so its color matches the input border accent.
    const { mode } = usePromptConfig();
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
                ref={transcriptScrollRef}
                flexGrow={1}
                width="100%"
                stickyScroll
                stickyStart="bottom"
                viewportCulling={false}
            >
                {/* viewportCulling off: sticky scroll must measure full transcript height. */}
                <box>
                    {children}
                </box>
            </scrollbox>
            <box flexShrink={0}>
                <InputBar onSubmit={onSubmit} disabled={inputDisabled} composerRestoreText={composerRestoreText} composerRestoreToken={composerRestoreToken} subagentRunning={subagentRunning} subagentType={subagentType} />
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
                    {loading && !subagentRunning ? (
                        <>
                            {/* Spinner tint follows agent mode (Build = primary, Plan = planMode). */}
                            <Spinner mode={mode} />
                            {interruptible ? <text>esc to interrupt</text> : null}
                        </>
                    ) : null}
                </box>
                <box
                    flexDirection="row"
                    gap={1}
                    flexShrink={0}
                    marginLeft="auto"
                >
                    {/* Tab hint mirrors InputBar's toggleMode binding (not yet wired here). */}
                    <text>tab</text>
                    <text attributes={TextAttributes.DIM}>agent</text>
                </box>
            </box>
        </box>
    );
}
