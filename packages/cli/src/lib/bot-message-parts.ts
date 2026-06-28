import type { Message } from "../hooks/use-chat";

type ClientMessagePart = Message["parts"][number];

export type PartGroup = {
  type: ClientMessagePart["type"];
  parts: ClientMessagePart[];
  key: string;
};

function isToolPart(part: ClientMessagePart): boolean {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

/** Merge adjacent parts of the same type so reasoning/tool blocks stack cleanly. */
export function groupConsecutiveParts(parts: ClientMessagePart[]): PartGroup[] {
  const groups: PartGroup[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const lastGroup = groups[groups.length - 1];

    if (lastGroup && lastGroup.type === part.type) {
      lastGroup.parts.push(part);
    } else {
      const key =
        isToolPart(part) && "toolCallId" in part
          ? `group-tc-${part.toolCallId}`
          : `group-${part.type}-${i}`;
      groups.push({ type: part.type, parts: [part], key });
    }
  }

  return groups;
}

/** Stable React key for a part inside a grouped render batch. */
export function partRenderKey(groupKey: string, partType: string, index: number): string {
  return `${groupKey}-${partType}-${index}`;
}
