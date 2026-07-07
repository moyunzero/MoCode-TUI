import type { RefObject } from "react";
import { TextAttributes,type ScrollBoxRenderable } from "@opentui/core";
import { getFilteredCommands } from "./filter-commands";
import type { Command } from "./types";
import { useTheme } from "../../providers/theme";
/** Max rows shown before the list scrolls. */
const MAX_VISIBLE_ITEMS = 8;

type CommandMenuProps = {
    query: string;
    selectedIndex: number;
    scrollRef: RefObject<ScrollBoxRenderable | null>;
    commands: Command[];
    commandColWidth: number;
    onSelect: (index: number) => void;
    onExecute: (index: number) => void;
};


export function CommandMenu({ 
    query, 
    selectedIndex, 
    scrollRef,
    commands,
    commandColWidth,
    onSelect, 
    onExecute 
}: CommandMenuProps) {
    const filtered = getFilteredCommands(query, commands);
    const visibleHeight = Math.min(filtered.length,MAX_VISIBLE_ITEMS);
    const { colors } = useTheme();
    if(filtered.length === 0) {
        return (
            <box paddingX={1}>
                <text attributes={TextAttributes.DIM} >
                    No matching commands
                </text>
            </box>
        );
    }
    return(
        <scrollbox 
            ref={scrollRef} 
            height={visibleHeight} 
        >
            {filtered.map((cmd,i)=>{
                const isSelected = i === selectedIndex;
                return(
                    <box
                        key={cmd.value}
                        paddingX={1}
                        flexDirection="row"
                        height={1}
                        overflow="hidden"
                        backgroundColor={isSelected? colors.selection : undefined}
                        onMouseMove={()=>{onSelect(i)}}
                        onMouseDown={()=>{onExecute(i)}}
                    >
                        <box
                            width={commandColWidth}
                            flexShrink={0}    
                        >
                            <text
                                selectable={false}
                                fg={isSelected? "black" : "white"}
                            >
                                /{cmd.name}
                            </text>
                        </box>
                        <box 
                            flexGrow={1} 
                            flexShrink={1} 
                            overflow="hidden"
                        >
                            <text
                                selectable={false}
                                fg={isSelected? "black" : "gray"}
                            >
                                {cmd.description}
                            </text>
                        </box>
                    </box>
                );
            })}
        </scrollbox>
    );
};
