/** Runtime context passed to slash-command actions. */
export type CommandContext = {
    exit: () => void;
}

export type Command = {
    name: string;
    description: string;
    value: string;
    /** Optional side effect; otherwise the command value is inserted into the textarea. */
    action?:(ctx:CommandContext) => void | Promise<void>;
}