import type { LanguageModelUsage } from "ai";
import type { Prisma } from "@mocode/database";
import { calculateCreditsForUsage } from "./credits";
import { ingestAiUsage } from "./polar";
import { resolveChatModel } from "./model";

type SessionUpdateClient = {
  session: {
    update: (args: {
      where: { id: string; userId: string };
      data: { messages: Prisma.InputJsonValue };
    }) => Promise<unknown>;
  };
};

export type ResolveSubagentChatFinishParams = {
  persist: boolean;
  sessionId: string;
  userId: string;
  messages: unknown[];
  responseMessageId?: string;
  completedUsage?: LanguageModelUsage | null;
  db: SessionUpdateClient;
  ingestAiUsage?: typeof ingestAiUsage;
  model?: string;
};

function resolveCredits(params: ResolveSubagentChatFinishParams): number {
  if (!params.completedUsage) {
    return 0;
  }
  if (!params.model) {
    return 1;
  }
  const resolvedModel = resolveChatModel(params.model);
  return calculateCreditsForUsage({
    provider: resolvedModel.provider,
    model: resolvedModel.modelId,
    usage: params.completedUsage,
  }).credits;
}

/**
 * Persists chat finish for normal turns; skips message DB write for ephemeral subagent streams (D-17).
 * Token usage still bills to the parent session when present (D-09).
 */
export async function resolveSubagentChatFinish(
  params: ResolveSubagentChatFinishParams,
): Promise<void> {
  const ingest = params.ingestAiUsage ?? ingestAiUsage;

  if (params.persist) {
    await params.db.session.update({
      where: { id: params.sessionId, userId: params.userId },
      data: {
        messages: params.messages as Prisma.InputJsonValue,
      },
    });
  }

  if (!params.completedUsage) {
    return;
  }

  await ingest({
    externalCustomerId: params.userId,
    eventId: `chat-message:${params.responseMessageId ?? params.sessionId}`,
    credits: resolveCredits(params),
  });
}
