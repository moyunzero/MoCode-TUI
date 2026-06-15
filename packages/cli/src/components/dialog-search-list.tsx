/**
 * Searchable, keyboard-navigable list for dialog content.
 * Arrow keys move selection; Enter confirms. Requires the "dialog" keyboard layer.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState,type ReactNode } from "react";
import { TextAttributes,type ScrollBoxRenderable,type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { useTheme } from "../providers/theme";
import { scrollIndexIntoView, scrollIndexIntoViewAfterLayout, visibleItemCount } from "../utils/list-scroll-nav";

const MAX_VISIBLE_ITEMS = 6;

type DialogSearchListProps<T> = {
    items: T[];
    onSelect: (item: T) => void;
    onHighlight?: (item: T) => void;
    filterFn:(item:T,query:string)=>boolean;
    renderItem:(item:T,isSelected:boolean)=>ReactNode;
    getKey:(item:T)=>string;
    placeholder?:string;
    emptyText?:string;
    /** Initial keyboard selection; list scrolls to this row on open. */
    initialSelectedIndex?: number;
}

export function DialogSearchList<T>({ 
    items, 
    onSelect, 
    onHighlight, 
    filterFn, 
    renderItem, 
    getKey, 
    placeholder = "Search...", 
    emptyText = "No items found",
    initialSelectedIndex,
}: DialogSearchListProps<T>) {
    const [searchValue,setSearchValue] = useState("");
    const [selectedIndex,setSelectedIndex] = useState(() => {
        if (initialSelectedIndex == null || items.length === 0) return 0;
        return Math.min(Math.max(0, initialSelectedIndex), items.length - 1);
    });
    const scrollRef = useRef<ScrollBoxRenderable>(null);
    const inputRef = useRef<InputRenderable>(null);
    const skipHighlightRef = useRef(true);
    const {isTopLayer} = useKeyboardLayer();
    const { colors } = useTheme();

    const handleContentChange= useCallback(()=>{
        const text = inputRef.current?.value ?? "";
        setSearchValue(text);
        setSelectedIndex(0);
        const scrollbox = scrollRef.current;
        if(scrollbox){
            scrollbox.scrollTo(0);
        }
    },[]);

    const filtered = searchValue ? items.filter((item)=>filterFn(item,searchValue)) : items;

    const pageSize = visibleItemCount(filtered.length, MAX_VISIBLE_ITEMS);

    // Keyboard nav: scroll after commit so theme preview re-renders cannot undo scrollTop.
    useLayoutEffect(() => {
        const scrollbox = scrollRef.current;
        if (!scrollbox || filtered.length === 0) return;
        scrollIndexIntoView(scrollbox, selectedIndex, pageSize);
    }, [selectedIndex, filtered.length, pageSize]);

    // Open dialog: OpenTUI scroll metrics are not ready on the first layout pass.
    useEffect(() => {
        if (initialSelectedIndex == null || initialSelectedIndex <= 0) return;
        const scrollbox = scrollRef.current;
        if (!scrollbox || filtered.length === 0) return;
        return scrollIndexIntoViewAfterLayout(scrollbox, initialSelectedIndex, pageSize);
    }, [initialSelectedIndex, filtered.length, pageSize]);

    useEffect(() => {
        if (skipHighlightRef.current) {
            skipHighlightRef.current = false;
            return;
        }
        const item = filtered[selectedIndex];
        if (item && onHighlight) {
            onHighlight(item);
        }
    }, [selectedIndex, filtered, onHighlight]);

    useKeyboard((key)=>{
        if(!isTopLayer("dialog")) return;

        if(key.name === "return" || key.name === "enter"){
           const item = filtered[selectedIndex];
           if(item){
            onSelect(item);
           }
        }else if(key.name === "up"){
            key.preventDefault();
            setSelectedIndex((i)=>Math.max(0,i-1));
        }else if(key.name === "down"){
            key.preventDefault();
            setSelectedIndex((i)=>{
                if(filtered.length === 0){
                    return 0;
                }
                return Math.min(filtered.length-1,i+1);
            });
        }
    });
    return(
        <box flexDirection="column" gap={1}>
            <input 
                ref={inputRef}
                placeholder={placeholder}
                focused
                onContentChange={handleContentChange}
            />
            {filtered.length===0?(
                <text attributes={TextAttributes.DIM}>
                    {emptyText}
                </text>
            ):(
                <scrollbox ref={scrollRef} height={pageSize}>
                    {filtered.map((item,i)=>{
                        const isSelected = i === selectedIndex;
                        return(
                            <box 
                                key={getKey(item)} 
                                flexDirection="row"
                                height={1} 
                                overflow="hidden" 
                                backgroundColor={isSelected? colors.selection : undefined} 
                                onMouseMove={()=>{
                                    setSelectedIndex(i);
                                    if(onHighlight){
                                        onHighlight(item);
                                    }
                                }} 
                                onMouseDown={()=>onSelect(item)}
                            >
                                {renderItem(item,isSelected)}
                            </box>
                        )
                    })}
                </scrollbox>
            )}
        </box>
    )
}