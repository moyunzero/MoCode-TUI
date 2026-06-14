import { useMemo, useRef, useState, type RefObject } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { getFilteredCommands } from "./filter-commands";
import type { Command } from "./types";

type UseCommandMenuReturn = {
    showCommandMenu: boolean;
    commandQuery: string;
    selectedIndex: number;
    scrollRef: RefObject<ScrollBoxRenderable | null>;
    handleContentChange: (text: string) => void;
    resolveCommand: (index: number) => Command | undefined;
    setSelectedIndex: (index: number) => void;
}

export function useCommandMenu():UseCommandMenuReturn {
    const scrollRef = useRef<ScrollBoxRenderable>(null);
    const [textValue,setTextValue] = useState("");
    const [selectedIndex,setSelectedIndex] = useState(0);
    const [showCommandMenu,setShowCommandMenu] = useState(false);

    // Text after "/" used for prefix filtering; empty string shows all commands.
    const commandQuery = showCommandMenu && textValue.startsWith("/") ? textValue.slice(1) : "";

    const filteredCommands = useMemo(()=>getFilteredCommands(commandQuery),[commandQuery]);

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
        }else{
            setShowCommandMenu(false);
        }
    };

    const resolveCommand = (index:number):Command | undefined => {
        const command = filteredCommands[index];
        if(command){
            setShowCommandMenu(false);
        }
        return command;
    }

    // Arrow keys and Escape are handled here; Enter is handled by InputBar onSubmit.
    useKeyboard((key)=>{
        if(!showCommandMenu) return;
        if(key.name === "escape") {
            key.preventDefault();
            setShowCommandMenu(false);
        }else if(key.name === "up") {
            key.preventDefault();
            setSelectedIndex((i:number)=>{
                const newIndex = Math.max(0,i-1);
                const scrollbox = scrollRef.current;
                if(scrollbox && newIndex < scrollbox.scrollTop) {
                    scrollbox.scrollTo(newIndex);
                }
                return newIndex;
            });
        }else if (key.name === "down") {
            key.preventDefault();
            setSelectedIndex((i:number)=>{
                if(filteredCommands.length === 0){
                    return 0
                }
                const newIndex = Math.min(filteredCommands.length-1,i+1);
                const scrollbox = scrollRef.current;
                if(scrollbox){
                    const viewportHeight = scrollbox.viewport.height;
                    const visibleEnd = scrollbox.scrollTop + viewportHeight -1;
                    if(newIndex > visibleEnd){
                        scrollbox.scrollTo(newIndex-viewportHeight+1);
                    }
                }
                return newIndex;
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