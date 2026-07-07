import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { getFilteredCommands } from "./filter-commands";
import type { Command } from "./types";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { scrollIndexIntoView, visibleItemCount } from "../../utils/list-scroll-nav";

/** Max rows shown before the list scrolls. */
const MAX_VISIBLE_ITEMS = 8;

type UseCommandMenuReturn = {
    showCommandMenu: boolean;
    commandQuery: string;
    selectedIndex: number;
    scrollRef: RefObject<ScrollBoxRenderable | null>;
    handleContentChange: (text: string) => void;
    resolveCommand: (index: number) => Command | undefined;
    setSelectedIndex: (index: number) => void;
}

export function useCommandMenu(commands: Command[]): UseCommandMenuReturn {
    const scrollRef = useRef<ScrollBoxRenderable>(null);
    const [textValue,setTextValue] = useState("");
    const [selectedIndex,setSelectedIndex] = useState(0);
    const [showCommandMenu,setShowCommandMenu] = useState(false);

    const { push, pop, isTopLayer } = useKeyboardLayer();

    // Closing the menu also releases the "command" keyboard layer.
    const close = ()=>{
        setShowCommandMenu(false);
        pop("command");
    }

    // Text after "/" used for prefix filtering; empty string shows all commands.
    const commandQuery = showCommandMenu && textValue.startsWith("/") ? textValue.slice(1) : "";

    const filteredCommands = useMemo(
      () => getFilteredCommands(commandQuery, commands),
      [commandQuery, commands],
    );
    const pageSize = visibleItemCount(filteredCommands.length, MAX_VISIBLE_ITEMS);

    useLayoutEffect(() => {
        if (!showCommandMenu) return;
        const scrollbox = scrollRef.current;
        if (!scrollbox || filteredCommands.length === 0) return;
        scrollIndexIntoView(scrollbox, selectedIndex, pageSize);
    }, [showCommandMenu, selectedIndex, filteredCommands.length, pageSize]);

    const handleContentChange = (text:string) => {
        setTextValue(text);
        setSelectedIndex(0);

        const scrollbox = scrollRef.current;
        if(scrollbox){
            scrollbox.scrollTo(0);
        }
    
        const prefix = text.startsWith("/") ? text.slice(1) : null;

        // Keep menu open only while typing a single token: "/new", not "/new arg".
        if(prefix !== null && !prefix.includes(" ")){
            setShowCommandMenu(true);
            // Ctrl+C while the menu is open clears input instead of exiting.
            push("command",()=>{
                close();
                return true;
            })
        }else{
            close();
        }
    };

    const resolveCommand = (index:number):Command | undefined => {
        const command = filteredCommands[index];
        if(command){
           close();
        }
        return command;
    }

    // Arrow keys and Escape are handled here; Enter is handled by InputBar onSubmit.
    // Ignore keys when a dialog sits above the command menu on the layer stack.
    useKeyboard((key)=>{
        if(!showCommandMenu || !isTopLayer("command")) return;
        if(key.name === "escape") {
            key.preventDefault();
            close();
        }else if(key.name === "up") {
            key.preventDefault();
            setSelectedIndex((i:number)=>Math.max(0,i-1));
        }else if (key.name === "down") {
            key.preventDefault();
            setSelectedIndex((i:number)=>{
                if(filteredCommands.length === 0){
                    return 0
                }
                return Math.min(filteredCommands.length-1,i+1);
            });
        }
        
    });
    return {
        showCommandMenu,
        commandQuery,
        selectedIndex,
        scrollRef,
        handleContentChange,
        resolveCommand,
        setSelectedIndex,
    }
}