import { z } from "zod";

/** Canonical list of chat models the CLI and API accept. Single source of truth for validation. */

/** USD pricing per million tokens; Phase 10 uses this for Polar credit conversion. */
export type ModelPricing = {
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  };
  
  /** Upstream LLM vendor backing a catalog entry. */
  export type SupportedProvider =
    | "anthropic"
    | "openai"
    | "google"
    | "groq"
    | "cerebras"
    | "openrouter";
  
  type SupportedChatModelDefinition = {
    id: string;
    provider: SupportedProvider;
    /** Per-model rates consumed by server `calculateCreditsForUsage`. */
    pricing: ModelPricing;
  };
  
  /** Models exposed to users; `as const` keeps ids literal for type inference. */
  export const SUPPORTED_CHAT_MODELS = [
    {
      id: "claude-sonnet-4-6",
      provider: "anthropic",
      pricing: {
        inputUsdPerMillionTokens: 3,
        outputUsdPerMillionTokens: 15,
      },
    },
    {
      id: "claude-haiku-4-5",
      provider: "anthropic",
      pricing: {
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 5,
      },
    },
    {
      id: "claude-opus-4-6",
      provider: "anthropic",
      pricing: {
        inputUsdPerMillionTokens: 5,
        outputUsdPerMillionTokens: 25,
      },
    },
    {
      id: "gpt-5.4",
      provider: "openai",
      pricing: {
        inputUsdPerMillionTokens: 2.5,
        outputUsdPerMillionTokens: 15,
      },
    },
    {
      id: "gpt-5.4-mini",
      provider: "openai",
      pricing: {
        inputUsdPerMillionTokens: 0.75,
        outputUsdPerMillionTokens: 4.5,
      },
    },
    {
      id: "gpt-5.4-nano",
      provider: "openai",
      pricing: {
        inputUsdPerMillionTokens: 0.2,
        outputUsdPerMillionTokens: 1.25,
      },
    },
    {
      id: "gemini-2.5-flash",
      provider: "google",
      pricing: {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
      },
    },
    {
      id: "gemini-2.5-flash-lite",
      provider: "google",
      pricing: {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
      },
    },
    {
      id: "llama-3.3-70b-versatile",
      provider: "groq",
      pricing: {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
      },
    },
    {
      id: "llama-3.1-8b-instant",
      provider: "groq",
      pricing: {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
      },
    },
    {
      id: "openai/gpt-oss-120b",
      provider: "groq",
      pricing: {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
      },
    },
    {
      id: "gpt-oss-120b",
      provider: "cerebras",
      pricing: {
        inputUsdPerMillionTokens: 0,
        outputUsdPerMillionTokens: 0,
      },
    },
    {
      id: "openai/gpt-oss-120b:free",
      provider: "openrouter",
      pricing: {
        inputUsdPerMillionTokens: 0.1,
        outputUsdPerMillionTokens: 0.1,
      },
    },
  ] as const satisfies readonly SupportedChatModelDefinition[];
  
  export type SupportedChatModel = (typeof SUPPORTED_CHAT_MODELS)[number];
  
  export type SupportedChatModelId = SupportedChatModel["id"];
  
  /** Returns catalog metadata for a string id, or null when unsupported. */
  export function findSupportedChatModel(modelId: string) {
    return SUPPORTED_CHAT_MODELS.find((model) => model.id === modelId);
  }

  /** Runtime validator for model ids from {@link SUPPORTED_CHAT_MODELS}. */
  export const supportedChatModelIdSchema = z.string().refine(
    (id): id is SupportedChatModelId => findSupportedChatModel(id) != null,
    { message: "Unsupported chat model" },
  );
  
  /** Default model when the session UI does not expose an explicit picker yet. */
  export const DEFAULT_CHAT_MODEL_ID: SupportedChatModelId = "gpt-oss-120b";

  /** BYOK catalog hints for the `/models` picker (free-tier tool-calling guidance). */
  export type ModelCatalogHint = "free-recommended" | "free-ok" | "weak-tools";

  const MODEL_CATALOG_HINTS: Partial<Record<SupportedChatModelId, ModelCatalogHint>> = {
    "gpt-oss-120b": "free-recommended",
    "openai/gpt-oss-120b": "free-ok",
    "gemini-2.5-flash": "free-ok",
    "llama-3.3-70b-versatile": "weak-tools",
    "llama-3.1-8b-instant": "weak-tools",
    "gemini-2.5-flash-lite": "weak-tools",
    "openai/gpt-oss-120b:free": "weak-tools",
  };

  const MODEL_CATALOG_HINT_SORT: Record<ModelCatalogHint, number> = {
    "free-recommended": 0,
    "free-ok": 1,
    "weak-tools": 3,
  };

  /** Returns catalog hint for a model id, if any. */
  export function getModelCatalogHint(modelId: SupportedChatModelId): ModelCatalogHint | undefined {
    return MODEL_CATALOG_HINTS[modelId];
  }

  /** User-facing label for a catalog hint. */
  export function formatModelCatalogHint(hint: ModelCatalogHint): string {
    switch (hint) {
      case "free-recommended":
        return "免费推荐";
      case "free-ok":
        return "免费可用";
      case "weak-tools":
        return "工具调用不稳定";
    }
  }

  /** Sorts model ids for the picker: recommended free models first, weak tools last. */
  export function sortModelsForCatalogPicker(
    modelIds: readonly SupportedChatModelId[],
  ): SupportedChatModelId[] {
    return [...modelIds].sort((left, right) => {
      const leftHint = getModelCatalogHint(left);
      const rightHint = getModelCatalogHint(right);
      const leftOrder = leftHint ? MODEL_CATALOG_HINT_SORT[leftHint] : 2;
      const rightOrder = rightHint ? MODEL_CATALOG_HINT_SORT[rightHint] : 2;
      if (leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      return left.localeCompare(right);
    });
  }