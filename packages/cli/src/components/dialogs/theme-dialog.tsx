import { useCallback,useRef,useEffect } from "react";
import { useDialog } from "../../providers/dialog";
import { useTheme } from "../../providers/theme";
import { DialogSearchList } from "../dialog-search-list";
import { THEMES } from "../../theme";
import type { Theme } from "../../theme";

/** Live-previews themes on highlight; reverts to the original unless the user confirms. */
export const ThemeDialogContent = () => {
   const dialog = useDialog();
   const { setTheme,currentTheme } = useTheme();
   const originalThemeRef  = useRef<Theme>(currentTheme);
   const confirmedRef = useRef(false);

   // Unmount without selection (e.g. Escape) rolls back the preview.
   useEffect(()=>{
    return()=>{
        if(!confirmedRef.current){
            setTheme(originalThemeRef.current, { persist: false });
        }
    }
   },[setTheme]);

   const handleSelect = useCallback((theme:Theme)=>{
    confirmedRef.current = true;
    setTheme(theme);
    dialog.close();
   },[setTheme,dialog]);

   const handleHighlight = useCallback((theme:Theme)=>{
    setTheme(theme, { persist: false });
   },[setTheme]);

   const initialSelectedIndex = THEMES.findIndex((t) => t.name === originalThemeRef.current.name);

   return(
    <DialogSearchList
        items={THEMES}
        initialSelectedIndex={Math.max(0, initialSelectedIndex)}
        onSelect={handleSelect}
        onHighlight={handleHighlight}
        filterFn={(theme,query)=>theme.name.toLowerCase().includes(query.toLowerCase())}
        renderItem={(theme,isSelected)=>(
            <text selectable={false} fg={isSelected? "black" : "white"}>
                {theme.name === originalThemeRef.current.name ? "\u0020\u2022\u0020" : "\u0020\u0020\u0020"}
                {theme.name}
            </text>
        )}
        getKey={(theme)=>theme.name}
        placeholder="Search themes..."
        emptyText="No themes found"
    />
   )

}