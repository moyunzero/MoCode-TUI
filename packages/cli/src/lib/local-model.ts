/**
 * BYOK model resolution from keys.json (D-12).
 *
 * Mirrors packages/server/src/lib/model.ts but injects user API keys from
 * getKeys() instead of process.env. Never logs apiKey values.
 *
 * Provider-specific `providerOptions` enable reasoning/thinking streams where the
 * upstream SDK supports them (Anthropic adaptive thinking, OpenRouter reasoning, etc.).
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createCerebras } from "@ai-sdk/cerebras";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

import {
  findSupportedChatModel,
  type SupportedChatModel,
  type SupportedChatModelId,
  type SupportedProvider,
} from "@mocode/shared";

import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { LanguageModel } from "ai";

import { getKeys, type KeysOptions, type ProviderKeys } from "./keys";

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

export type ResolveChatModelOptions = KeysOptions & {
  getKeys?: typeof getKeys;
};

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

function requireProviderApiKey(
  provider: SupportedProvider,
  keys: ProviderKeys | null,
): string {
  if (!keys) {
    throw new Error(
      `Missing API keys for ${provider}. Run /keys in MoCode to configure your provider API key.`,
    );
  }

  const entry = keys[provider];
  if (typeof entry?.apiKey !== "string" || entry.apiKey.length === 0) {
    throw new Error(
      `Missing ${provider} API key. Run /keys in MoCode to configure your provider API key.`,
    );
  }

  return entry.apiKey;
}

function resolveAnthropicModel(modelId: AnthropicModelId, apiKey: string): ResolvedModel {
  const provider = createAnthropic({ apiKey });
  return {
    model: provider(modelId),
    provider: "anthropic",
    modelId,
    providerOptions: ANTHROPIC_PROVIDER_OPTIONS[modelId],
  };
}

function resolveOpenAIModel(modelId: OpenAIModelId, apiKey: string): ResolvedModel {
  const provider = createOpenAI({ apiKey });
  return {
    model: provider(modelId),
    provider: "openai",
    modelId,
    providerOptions: OPENAI_PROVIDER_OPTIONS[modelId],
  };
}

function resolveGoogleModel(modelId: GoogleModelId, apiKey: string): ResolvedModel {
  const provider = createGoogleGenerativeAI({ apiKey });
  return {
    model: provider(modelId),
    provider: "google",
    modelId,
    providerOptions: GOOGLE_PROVIDER_OPTIONS[modelId],
  };
}

function resolveGroqModel(modelId: GroqModelId, apiKey: string): ResolvedModel {
  const provider = createGroq({ apiKey });
  return {
    model: provider(modelId),
    provider: "groq",
    modelId,
  };
}

function resolveCerebrasModel(modelId: CerebrasModelId, apiKey: string): ResolvedModel {
  const provider = createCerebras({ apiKey });
  return {
    model: provider(modelId),
    provider: "cerebras",
    modelId,
    providerOptions: CEREBRAS_PROVIDER_OPTIONS[modelId],
  };
}

function resolveOpenRouterModel(modelId: OpenRouterModelId, apiKey: string): ResolvedModel {
  const openrouter = createOpenRouter({ apiKey });
  return {
    model: openrouter(modelId),
    provider: "openrouter",
    modelId,
    providerOptions: OPENROUTER_PROVIDER_OPTIONS[modelId],
  };
}

function resolveSupportedChatModel(
  model: SupportedChatModel,
  keys: ProviderKeys | null,
): ResolvedModel {
  switch (model.provider) {
    case "anthropic":
      return resolveAnthropicModel(
        model.id,
        requireProviderApiKey("anthropic", keys),
      );
    case "openai":
      return resolveOpenAIModel(model.id, requireProviderApiKey("openai", keys));
    case "google":
      return resolveGoogleModel(model.id, requireProviderApiKey("google", keys));
    case "groq":
      return resolveGroqModel(model.id, requireProviderApiKey("groq", keys));
    case "cerebras":
      return resolveCerebrasModel(model.id, requireProviderApiKey("cerebras", keys));
    case "openrouter":
      return resolveOpenRouterModel(
        model.id,
        requireProviderApiKey("openrouter", keys),
      );
    default: {
      const _exhaustive: never = model;
      throw new Error(`Unsupported provider: ${String(_exhaustive)}`);
    }
  }
}

/** Looks up catalog entry and returns the bound SDK model using keys.json credentials. */
export function resolveChatModel(
  modelId: string,
  options?: ResolveChatModelOptions,
): ResolvedModel {
  const model = findSupportedChatModel(modelId);
  if (!model) {
    throw new Error(`Model ${modelId} not found`);
  }

  const getKeysFn = options?.getKeys ?? getKeys;
  const keys = getKeysFn(options);
  return resolveSupportedChatModel(model, keys);
}
