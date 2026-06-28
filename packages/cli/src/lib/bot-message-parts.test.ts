import { describe, expect, test } from "bun:test";
import { groupConsecutiveParts, partRenderKey } from "./bot-message-parts";

describe("groupConsecutiveParts", () => {
  test("merges adjacent reasoning parts into one group", () => {
    const groups = groupConsecutiveParts([
      { type: "reasoning", text: "a" },
      { type: "reasoning", text: "b" },
      { type: "text", text: "answer" },
    ] as never);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.type).toBe("reasoning");
    expect(groups[0]?.parts).toHaveLength(2);
    expect(groups[1]?.type).toBe("text");
  });
});

describe("partRenderKey", () => {
  test("stays unique when duplicate text appears in the same group", () => {
    const groupKey = "group-reasoning-0";
    const keys = [0, 1].map((index) => partRenderKey(groupKey, "reasoning", index));

    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual(["group-reasoning-0-reasoning-0", "group-reasoning-0-reasoning-1"]);
  });
});
