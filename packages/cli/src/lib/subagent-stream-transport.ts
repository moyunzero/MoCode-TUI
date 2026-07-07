/**
 * SaaS subagent stream transport — POST /chat with persist: false (D-17, D-20).
 */
import { readUIMessageStream, type UIMessage } from "ai";
import type { ModeType, SerializedMcpTool } from "@mocode/shared";
import { apiClient } from "./api-client";
import { getAuth } from "./auth";
import { getErrorMessage } from "./http-errors";

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
