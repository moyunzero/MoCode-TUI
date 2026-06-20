import { useTheme } from "../../providers/theme";
import { EmptyBorder } from "../border";
import { Mode } from "@mocode/database/enums";

type Props = {
    message: string;
    mode: Mode;
}

export function UserMessage({ message, mode }: Props){
    const { colors } = useTheme();

    return (
        <box width="100%" alignItems="center">
            <box
                border={["left"]}
                borderColor={mode === Mode.PLAN ? colors.planMode : colors.primary}
                width="100%"
                customBorderChars={{
                    ...EmptyBorder,
                    vertical: "┃",
                }}
            >
                <box
                    justifyContent="center"
                    paddingX={2}
                    paddingY={1}
                    backgroundColor={colors.surface}
                    width="100%"
                >
                    <text>{message}</text>
                </box>
            </box>
        </box>
    );
}
