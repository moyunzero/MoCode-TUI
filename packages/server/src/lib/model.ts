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

import type { ProviderOptions } from '@ai-sdk/provider-utils';
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
    /** Passed to `streamText({ providerOptions })` to enable provider-native reasoning/thinking streams. */
    providerOptions?: ProviderOptions;
};

/**
 * Per-model reasoning/thinking configuration (Phase 8).
 *
 * When set, the AI SDK emits `reasoning-delta` chunks on `fullStream`, which the
 * chat route forwards as SSE and persists in Message.parts. Models not listed here
 * still work but only stream plain text deltas.
 */
const ANTHROPIC_PROVIDER_OPTIONS: Partial<Record<AnthropicModelId, ProviderOptions>> = {
    "claude-sonnet-4-6": {
        anthropic: {
            thinking: { type: "adaptive", display: "summarized" },
        },
    },
    "claude-haiku-4-5": {
        anthropic: {
            thinking: { type: "enabled", budgetTokens: 10000 },
        },
    },
    "claude-opus-4-6": {
        anthropic: {
            thinking: { type: "adaptive", display: "summarized" },
        },
    },
};

const OPENAI_PROVIDER_OPTIONS: Partial<Record<OpenAIModelId, ProviderOptions>> = {
    "gpt-5.4": {
        openai: {
            reasoningEffort: "medium",
            reasoningSummary: "auto",
        },
    },
    "gpt-5.4-mini": {
        openai: {
            reasoningEffort: "medium",
            reasoningSummary: "auto",
        },
    },
    "gpt-5.4-nano": {
        openai: {
            reasoningEffort: "low",
            reasoningSummary: "auto",
        },
    },
};

const GOOGLE_PROVIDER_OPTIONS: Partial<Record<GoogleModelId, ProviderOptions>> = {
    "gemini-2.5-flash": {
        google: {
            thinkingConfig: {
                includeThoughts: true,
            },
        },
    },
    "gemini-2.5-flash-lite": {
        google: {
            thinkingConfig: {
                includeThoughts: true,
            },
        },
    },
};

const CEREBRAS_PROVIDER_OPTIONS: Partial<Record<CerebrasModelId, ProviderOptions>> = {
    "gpt-oss-120b": {
        cerebras: {
            reasoningEffort: "medium",
        },
    },
};

const OPENROUTER_PROVIDER_OPTIONS: Partial<Record<OpenRouterModelId, ProviderOptions>> = {
    "openai/gpt-oss-120b:free": {
        openrouter: {
            reasoning: {
                enabled: true,
                effort: "medium",
            },
        },
    },
};

function resolveAnthropicModel(modelId: AnthropicModelId): ResolvedModel {
    return {
        model: anthropic(modelId),
        provider: "anthropic",
        modelId,
        providerOptions: ANTHROPIC_PROVIDER_OPTIONS[modelId],
    };
}

function resolveOpenAIModel(modelId: OpenAIModelId): ResolvedModel {
    return {
        model: openai(modelId),
        provider: "openai",
        modelId,
        providerOptions: OPENAI_PROVIDER_OPTIONS[modelId],
    };
}

function resolveGoogleModel(modelId: GoogleModelId): ResolvedModel {
    return {
        model: google(modelId),
        provider: "google",
        modelId,
        providerOptions: GOOGLE_PROVIDER_OPTIONS[modelId],
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
        providerOptions: CEREBRAS_PROVIDER_OPTIONS[modelId],
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
        providerOptions: OPENROUTER_PROVIDER_OPTIONS[modelId],
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
    return findSupportedChatModel(modelId) != null;
}

/** Looks up catalog entry and returns the bound SDK model (throws if unknown). */
export function resolveChatModel(modelId: string): ResolvedModel {
    const model = findSupportedChatModel(modelId);
    if (!model) {
        throw new Error(`Model ${modelId} not found`);
    }
    return resolveSupportedChatModel(model);
}
