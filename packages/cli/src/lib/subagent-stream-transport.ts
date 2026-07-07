/**
 * SaaS subagent stream transport — POST /chat with persist: false (D-17, D-20).
 */
import {
  convertToModelMessages,
  generateText,
  readUIMessageStream,
  stepCountIs,
  validateUIMessages,
  type ToolSet,
  type UIMessage,
} from "ai";
import type { ModeType, SerializedMcpTool } from "@mocode/shared";
import { deserializeMcpToolsToDynamic } from "@mocode/shared";
import { apiClient } from "./api-client";
import { getAuth } from "./auth";
import { getErrorMessage } from "./http-errors";
import { resolveChatModel } from "./local-model";

export type SubagentSaaSTurnParams = {
  sessionId: string;
  messages: UIMessage[];
  mode: ModeType;
  model: string;
  mcpTools: SerializedMcpTool[];
  system: string;
  tools: ToolSet;
  abortSignal?: AbortSignal;
};

export type SubagentSaaSTurnResult = {
  messages: UIMessage[];
  text: string;
  done: boolean;
};

function hasPendingToolCalls(message: UIMessage): boolean {
  return message.parts.some((part) => {
    if (part.type === "dynamic-tool" || part.type.startsWith("tool-")) {
      const state = (part as { state?: string }).state;
      return state !== "output-available" && state !== "output-error";
    }
    return false;
  });
}

function extractAssistantText(message: UIMessage | undefined): string {
  if (message?.role !== "assistant") {
    return "";
  }
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

/**
 * Runs one SaaS subagent step with local tool execute wrappers from runner.
 * Server-side inference uses ephemeral persist:false POST when wired end-to-end;
 * inner tools still execute on CLI per Phase 11.
 */
export async function runSubagentSaaSTurn(
  params: SubagentSaaSTurnParams,
): Promise<SubagentSaaSTurnResult> {
  const { messages, mode, model, mcpTools, system, tools, abortSignal } = params;

  if (abortSignal?.aborted) {
    const lastAssistant = messages.findLast((message) => message.role === "assistant");
    return {
      messages,
      text: extractAssistantText(lastAssistant),
      done: true,
    };
  }

  const mergedTools: ToolSet = {
    ...tools,
    ...deserializeMcpToolsToDynamic(mcpTools),
  };

  const validated = await validateUIMessages({
    messages,
    tools: mergedTools as Parameters<typeof validateUIMessages>[0]["tools"],
  });
  const modelMessages = await convertToModelMessages(validated, { tools: mergedTools });

  const resolved = resolveChatModel(model);
  const result = await generateText({
    model: resolved.model,
    system,
    messages: modelMessages,
    tools: mergedTools,
    stopWhen: stepCountIs(1),
    abortSignal,
    providerOptions: resolved.providerOptions,
  });

  const assistantMessage: UIMessage = {
    id: `subagent-assistant-${Date.now()}`,
    role: "assistant",
    parts: [{ type: "text", text: result.text }],
    metadata: { mode, model },
  };

  const nextMessages = [...validated, assistantMessage];
  const pending = hasPendingToolCalls(assistantMessage);

  return {
    messages: nextMessages,
    text: result.text,
    done: !pending,
  };
}

export type SubagentStreamTransportOptions = {
  sessionId: string;
  fetchImpl?: typeof fetch;
};

/** POST /chat with persist false for ephemeral subagent billing (D-09). */
export async function postSubagentChatStream(
  options: SubagentStreamTransportOptions,
  body: {
    messages: UIMessage[];
    mode: ModeType;
    model: string;
    mcpTools?: SerializedMcpTool[];
  },
  abortSignal?: AbortSignal,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = apiClient.chat.$url().toString();
  const headers = new Headers({ "Content-Type": "application/json" });
  const auth = getAuth();
  if (auth) {
    headers.set("Authorization", `Bearer ${auth.token}`);
  }

  const response = await fetchImpl(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        id: options.sessionId,
        persist: false,
        messages: body.messages,
        mode: body.mode,
        model: body.model,
        mcpTools: body.mcpTools,
      }),
      signal: abortSignal,
    },
  );

  if (!response.ok) {
    throw new Error(await getErrorMessage(response));
  }

  return response;
}

/** Consumes a SaaS UI message stream into final messages. */
export async function consumeSubagentStream(
  response: Response,
  originalMessage: UIMessage,
): Promise<UIMessage> {
  if (!response.body) {
    return originalMessage;
  }

  let latest = originalMessage;
  for await (const message of readUIMessageStream({
    stream: response.body,
    message: originalMessage,
  })) {
    latest = message;
  }
  return latest;
}
