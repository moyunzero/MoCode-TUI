/**
 * Token usage → credit conversion for Polar billing (Phase 10).
 *
 * Flow: AI SDK `LanguageModelUsage` → USD estimate from {@link ModelPricing}
 * → whole credits at $0.01/credit (minimum 1 when cost > 0).
 *
 * Pricing lives in `@mocode/shared` so CLI and server share one catalog.
 */
import {
    SUPPORTED_CHAT_MODELS,
    findSupportedChatModel,
    type ModelPricing,
  } from "@mocode/shared";
  import type { LanguageModelUsage } from "ai";
  
  type CalculateCreditsForUsageParams = {
    provider: string;
    model: string;
    usage: LanguageModelUsage;
  };
  
  type BillableUsage = {
    credits: number;
  };
  
  type TokenCounts = {
    inputTokens: number;
    outputTokens: number;
  };
  
  /** Catalog prices are per-million tokens; usage counts are per-token. */
  const TOKENS_PER_MILLION = 1_000_000;
  
  /** 1 credit = $0.01 USD; must stay in sync with Polar product/meter config. */
  const USD_PER_CREDIT = 0.01;
  
  /** Validates AI SDK usage before billing — both token fields must be non-negative integers. */
  function getTokenCounts(usage: LanguageModelUsage): TokenCounts {
    const inputTokens = usage.inputTokens;
    const outputTokens = usage.outputTokens;
  
    if (
      inputTokens == null ||
      outputTokens == null ||
      !Number.isFinite(inputTokens) ||
      !Number.isFinite(outputTokens) ||
      !Number.isInteger(inputTokens) ||
      !Number.isInteger(outputTokens) ||
      inputTokens < 0 ||
      outputTokens < 0
    ) {
      throw new Error("Credit conversion requires input and output token counts");
    }
  
    return {
      inputTokens,
      outputTokens,
    };
  };
  
  /** Resolves catalog pricing; rejects unknown provider/model pairs before ingest. */
  function getModelPricing(provider: string, model: string): ModelPricing {
    const supportedModel = findSupportedChatModel(model);
  
    if (!supportedModel || supportedModel.provider !== provider) {
      if (!SUPPORTED_CHAT_MODELS.some((supportedModel) => supportedModel.provider === provider)) {
        throw new Error(`Unsupported billing provider: ${provider}`);
      }
  
      throw new Error(`Unsupported billing model: ${model}`);
    }
  
    return supportedModel.pricing;
  };
  
  /** Linear cost from input/output token counts and per-million USD rates. */
  function estimateCostUsd({ inputTokens, outputTokens }: TokenCounts, pricing: ModelPricing) {
    return (
      (inputTokens * pricing.inputUsdPerMillionTokens +
        outputTokens * pricing.outputUsdPerMillionTokens) /
      TOKENS_PER_MILLION
    );
  };
  
  function convertUsdToCredits(estimatedCostUsd: number) {
    if (estimatedCostUsd <= 0) {
      return 0;
    }
  
    // If a request costs any non-zero amount, charge at least 1 credit, then
    // round up so partial credits always become a whole credit.
    return Math.max(1, Math.ceil(estimatedCostUsd / USD_PER_CREDIT));
  };
  
  
  /** Public entry: usage from `streamText` `onFinish` → credits to ingest into Polar. */
  export function calculateCreditsForUsage({
    provider,
    model,
    usage,
  }: CalculateCreditsForUsageParams): BillableUsage {
    const tokenCounts = getTokenCounts(usage);
    const pricing = getModelPricing(provider, model);
    const estimatedCostUsd = estimateCostUsd(tokenCounts, pricing);
    const credits = convertUsdToCredits(estimatedCostUsd);
  
    return {
      credits,
    };
  };