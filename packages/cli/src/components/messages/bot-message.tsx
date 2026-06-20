/**
 * Renders assistant output: reasoning blocks, tool invocations, and final text.
 *
 * Phase 8: assistant messages are part-based rather than a single string. Consecutive
 * parts of the same type are grouped visually (e.g. multiple tool calls in a row).
 */
import { useTheme } from "../../providers/theme";
import { EmptyBorder } from "../border";
import type { ClientMessagePart, ClientToolCallPart } from "../../hooks/use-chat";
import { Mode } from "@mocode/database/enums";
import { TextAttributes } from "@opentui/core";

/** Renders assistant output plus mode/model metadata footer. */
type Props = {
    parts: ClientMessagePart[];
    model: string;
    mode: Mode;
    duration?: string;
    /** True while tokens are still arriving (live row below transcript). */
    streaming?: boolean;
    /** True when the user interrupted before the server sent `done`. */
    interrupted?: boolean;
}

/** "readFile" → "Read File" for compact terminal display. */
function formatToolName(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/^./, (match) => match.toUpperCase());
};

/** Flatten tool args to a single line (path, pattern, command, etc.). */
function formatToolArgs(toolCall: ClientToolCallPart): string {
    return Object.values(toolCall.args).map(String).join(" ");
};

type PartGroup = {
    type: ClientMessagePart["type"];
    parts: ClientMessagePart[];
    key: string;
}

/** Merge adjacent parts of the same type into one visual group with shared padding. */
function groupConsecutiveParts(parts: ClientMessagePart[]): PartGroup[] {
    const groups: PartGroup[] = [];
    for (const [i, part] of parts.entries()) {
        const lastGroup = groups[groups.length - 1];

        if(lastGroup && lastGroup.type === part.type ){
            lastGroup.parts.push(part);
        }else{
            const key = part.type === "tool-call" ? `group-tc-${part.id}` : `group-${part.type}-${i}`;
            groups.push({ type: part.type, parts: [part], key});
        }
    }
    return groups;
}

export function BotMessage({ 
    parts,
    model,
    mode,
    duration,
    streaming = false,
    interrupted = false,
 }: Props){
    const { colors } = useTheme();
    return (
        <box width="100%" alignItems="center">
           {
            groupConsecutiveParts(parts).map((group)=>(
                <box key={group.key} paddingY={1} width="100%">
                    <box paddingX={3} width="100%">
                        {
                            group.parts.map((part,j)=>{
                                if(part.type === "reasoning"){
                                    // Dimmed left-border block — provider thinking tokens.
                                    return(
                                        <box
                                            key={`reasoning-${j}`}
                                            border = {["left"]}
                                            borderColor={colors.thinkingBorder}
                                            customBorderChars={{
                                                ...EmptyBorder,
                                                vertical: "┃",
                                            }}
                                            paddingX={2}
                                            width="100%"
                                        >
                                            <text attributes={TextAttributes.DIM}>
                                                <em fg={colors.thinking}>Thinking:</em>{part.text}
                                            </text>
                                        </box>
                                    );
                                }
                                if(part.type === "tool-call"){
                                    // Shows tool name + args; " ..." suffix while status === "calling".
                                    return (
                                        <box
                                            key={part.id}
                                            border = {["left"]}
                                            borderColor={colors.thinkingBorder}
                                            customBorderChars={{
                                                ...EmptyBorder,
                                                vertical: "┃",
                                            }}
                                            paddingX={2}
                                            width="100%"
                                        >
                                            <text attributes={TextAttributes.DIM}>
                                                <em fg={colors.info}>{formatToolName(part.name)}:</em>
                                                {formatToolArgs(part)}
                                                {part.status === "calling" ? " ...": ""}
                                            </text>
                                            
                                        </box>
                                    );
                                }
                                if(part.type === "text"){
                                    return(
                                        <box
                                            key={`text-${j}`}
                                            paddingX={3}
                                            width="100%"
                                        >
                                            <text>{part.text}</text>
                                        </box>
                                    );
                                }
                                return null;
                            })
                        }  
                    </box>
                </box>
            ))
           }

            <box paddingX={3} paddingBottom={1} gap={1} width="100%">
                <box flexDirection="row" gap={2}>
                    {/* Mode indicator: dimmed when the reply was cut short. */}
                    <text
                        attributes={interrupted ? TextAttributes.DIM : 0}
                        fg={interrupted? undefined : mode === Mode.PLAN ? colors.planMode : colors.primary}
                    >
                      ◉
                    </text>
                    
                    <box flexDirection="row" gap={1}>
                        <text
                            attributes={interrupted ? TextAttributes.DIM : 0}
                        >
                            {mode===Mode.PLAN? "Plan":"Build"}
                        </text>
                        <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                            {">"}
                        </text>
                        <text attributes={TextAttributes.DIM} >
                            {model}
                        </text>
                        { 
                            (duration || interrupted) && (
                                <>
                                    <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>
                                        {">"}
                                    </text>
                                    <text attributes={TextAttributes.DIM} >
                                        {interrupted ? "interrupted" : duration}
                                    </text>
                                </>
                            )
                        }
                    </box>
                </box>
            </box>
        </box>
    );
}
