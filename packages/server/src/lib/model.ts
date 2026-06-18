/**
 * Resolves shared {@link SupportedChatModelId} values to Vercel AI SDK
 * `LanguageModel` instances, one factory per upstream provider.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { cerebras } from "@ai-sdk/cerebras";
import { google } from "@ai-sdk/google";
import { groq } from "@ai-sdk/groq";
import { openai } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import {
    findSupportedChatModel,
    type SupportedChatModel,
    type SupportedChatModelId,
    type SupportedProvider,
} from "@mocode/shared";

import type { LanguageModel } from "ai";

/** Per-provider model id extracted from the shared catalog for compile-time safety. */
type AnthropicModelId = Extract<SupportedChatModel, { provider: "anthropic" }>["id"];
type OpenAIModelId = Extract<SupportedChatModel, { provider: "openai" }>["id"];
type GoogleModelId = Extract<SupportedChatModel, { provider: "google" }>["id"];
type GroqModelId = Extract<SupportedChatModel, { provider: "groq" }>["id"];
type CerebrasModelId = Extract<SupportedChatModel, { provider: "cerebras" }>["id"];
type OpenRouterModelId = Extract<SupportedChatModel, { provider: "openrouter" }>["id"];

export type ResolvedModel = {
    model: LanguageModel;
    provider: SupportedProvider;
    modelId: SupportedChatModelId;
};

function resolveAnthropicModel(modelId: AnthropicModelId): ResolvedModel {
    return {
        model: anthropic(modelId),
        provider: "anthropic",
        modelId,
    };
}

function resolveOpenAIModel(modelId: OpenAIModelId): ResolvedModel {
    return {
        model: openai(modelId),
        provider: "openai",
        modelId,
    };
}

function resolveGoogleModel(modelId: GoogleModelId): ResolvedModel {
    return {
        model: google(modelId),
        provider: "google",
        modelId,
    };
}

function resolveGroqModel(modelId: GroqModelId): ResolvedModel {
    return {
        model: groq(modelId),
        provider: "groq",
        modelId,
    };
}

function resolveCerebrasModel(modelId: CerebrasModelId): ResolvedModel {
    return {
        model: cerebras(modelId),
        provider: "cerebras",
        modelId,
    };
}

function resolveOpenRouterModel(modelId: OpenRouterModelId): ResolvedModel {
    const openrouter = createOpenRouter({
        apiKey: process.env.OPENROUTER_API_KEY,
    });
    return {
        model: openrouter(modelId),
        provider: "openrouter",
        modelId,
    };
}

function resolveSupportedChatModel(model: SupportedChatModel): ResolvedModel {
    switch (model.provider) {
        case "anthropic":
            return resolveAnthropicModel(model.id);
        case "openai":
            return resolveOpenAIModel(model.id);
        case "google":
            return resolveGoogleModel(model.id);
        case "groq":
            return resolveGroqModel(model.id);
        case "cerebras":
            return resolveCerebrasModel(model.id);
        case "openrouter":
            return resolveOpenRouterModel(model.id);
        default: {
            const _exhaustive: never = model;
            throw new Error(`Unsupported provider: ${String(_exhaustive)}`);
        }
    }
}

/** Type guard used by chat route Zod validation and resume model checks. */
export function isSupportedChatModel(modelId: string): modelId is SupportedChatModelId {
    return findSupportedChatModel(modelId) !== null;
}

/** Looks up catalog entry and returns the bound SDK model (throws if unknown). */
export function resolveChatModel(modelId: string): ResolvedModel {
    const model = findSupportedChatModel(modelId);
    if (!model) {
        throw new Error(`Model ${modelId} not found`);
    }
    return resolveSupportedChatModel(model);
}
