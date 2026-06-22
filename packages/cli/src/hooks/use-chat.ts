/**
 * Phase 11 — Chat hook with client-side tool execution.
 *
 * Wraps `@ai-sdk/react` `useChat` with a custom {@link DefaultChatTransport} that
 * posts to the server chat route. Tool *definitions* live on the server (via
 * `getToolContracts`); tool *execution* happens locally in {@link executeLocalTool}.
 *
 * The multi-step agent loop:
 * 1. User sends a message → server streams assistant text + tool-call parts.
 * 2. `onToolCall` runs each tool locally and calls `addToolOutput`.
 * 3. `sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls` re-posts
 *    once every tool call in the last assistant message has output, so the model
 *    can continue reasoning without another user turn.
 *
 * `prepareSendMessagesRequest` trims the payload: for tool-continuation turns it
 * sends `[previousUser, assistantWithToolCalls]` instead of the full history,
 * because the server merges against stored session messages.
 */
import { useMemo } from "react";
import { useChat as useAiChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  type InferUITools,
  lastAssistantMessageIsCompleteWithToolCalls,
  type LanguageModelUsage,
  type UIMessage,
} from "ai";
import { type ModeType, type SupportedChatModelId, type ToolContracts } from "@mocode/shared";
import { apiClient } from "../lib/api-client";
import { getAuth } from "../lib/auth";
import { executeLocalTool } from "../lib/local-tools";

export type ChatMessageMetadata = {
  /** PLAN or BUILD — controls which tools the server exposes and CLI may run. */
  mode?: ModeType;
  model?: SupportedChatModelId | string;
  /** Wall-clock time for the assistant turn, set on stream finish. */
  durationMs?: number;
  usage?: LanguageModelUsage;
};

/** Maps shared {@link ToolContracts} to UI message tool slots (output is unknown until local exec). */
type ChatTools = {
  [Name in keyof InferUITools<ToolContracts>]: {
    input: InferUITools<ToolContracts>[Name]["input"];
    output: unknown;
  };
};

export type Message = UIMessage<ChatMessageMetadata, never, ChatTools>;

export function useChat(sessionId: string, initialMessages: Message[]) {
  const transport = useMemo(() => {
    return new DefaultChatTransport<Message>({
      api: apiClient.chat.$url().toString(),
      headers() {
        const auth = getAuth();
        return auth ? { Authorization: `Bearer ${auth.token}` } : new Headers();
      },
      prepareSendMessagesRequest({ messages }) {
        const message = messages[messages.length - 1];
        if (!message) throw new Error("No message to send");

        // Fall back to the most recent message that carried mode/model metadata
        // (tool-continuation assistant messages may not repeat them).
        const metadata = messages.findLast(
          (m) => m.metadata?.mode && m.metadata?.model,
        )?.metadata;
        const previousMessage = messages[messages.length - 2];
        // Tool loop: server already has history; only ship the pair that changed.
        const requestMessages =
          message.role === "assistant" && previousMessage?.role === "user"
            ? [previousMessage, message]
            : [message];

        return {
          body: {
            id: sessionId,
            messages: requestMessages,
            mode: message.metadata?.mode ?? metadata?.mode,
            model: message.metadata?.model ?? metadata?.model,
          },
        }
      }
    });
  }, [sessionId]);

  const chat = useAiChat<Message>({
    id: sessionId,
    messages: initialMessages,
    transport,
    onToolCall({ toolCall }) {
      const mode = chat.messages.at(-1)?.metadata?.mode ?? "BUILD";

      // Fire-and-forget: addToolOutput triggers re-submit when all tools finish.
      void executeLocalTool(toolCall.toolName, toolCall.input, mode)
        .then((output) =>
          chat.addToolOutput({
            tool: toolCall.toolName as keyof ChatTools,
            toolCallId: toolCall.toolCallId,
            output,
          }),
        )
        .catch((error) =>
          chat.addToolOutput({
            tool: toolCall.toolName as keyof ChatTools,
            toolCallId: toolCall.toolCallId,
            state: "output-error",
            errorText: error instanceof Error ? error.message : String(error),
          }),
        );
    },
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
  });

  return {
    messages: chat.messages,
    status: chat.status,
    error: chat.error,
    submit: (params: { userText: string; mode: ModeType; model: SupportedChatModelId }) => {
      return chat.sendMessage({
        text: params.userText,
        metadata: {
          mode: params.mode,
          model: params.model,
        },
      })
    },
    abort: chat.stop,
    interrupt: chat.stop,
  };
};