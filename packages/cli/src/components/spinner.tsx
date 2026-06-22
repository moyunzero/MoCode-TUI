import "opentui-spinner/react";
import { useTheme } from "../providers/theme";
import { Mode, type ModeType } from "@mocode/shared";

type Props = {
    /** When omitted, defaults to BUILD (primary color). */
    mode?:ModeType;
}

/** Inline loading indicator; color matches the active agent mode border. */
export function Spinner(
    {mode = Mode.BUILD}: Props
){
    const { colors } = useTheme();
    const activeColor = mode === Mode.PLAN ? colors.planMode : colors.primary;
    return (
        <spinner name="simpleDots" color={activeColor} />
    );
}   