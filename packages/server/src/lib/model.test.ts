import { describe, expect, test } from "bun:test";
import { DEFAULT_CHAT_MODEL_ID } from "@mocode/shared";
import { isSupportedChatModel } from "./model";

describe("isSupportedChatModel", () => {
    test("accepts catalog model ids", () => {
        expect(isSupportedChatModel(DEFAULT_CHAT_MODEL_ID)).toBe(true);
    });

    test("rejects unknown model ids", () => {
        expect(isSupportedChatModel("not-a-real-model")).toBe(false);
        expect(isSupportedChatModel("")).toBe(false);
    });
});
