import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useLocation, useNavigate } from "react-router";
import { useKeyboard } from "@opentui/react";
import { type ModeType, type SupportedChatModelId } from "@mocode/shared";
import type { InferResponseType } from "hono/client";
import { SessionShell } from "../components/session-shell";
import { 
  UserMessage, 
  BotMessage, 
  ErrorMessage
} from "../components/messages";
import { useToast } from "../providers/toast";
import { useChat } from "../hooks/use-chat";
import { usePromptConfig } from "../providers/prompt-config";
import type { Message } from "../hooks/use-chat";
import { apiClient } from "../lib/api-client";
import { getErrorMessage } from "../lib/http-errors";
import { isLocalMode } from "../lib/local-mode";
import { getLocalSession } from "../lib/local-sessions";
import { useKeyboardLayer } from "../providers/keyboard-layer";
import { parseInitialMessages, sessionLocationSchema } from "../lib/session-navigation";
import { initMcpOnSessionMount } from "../mcp/session-mcp";

/**
 * Phase 11 session screen.
 *
 * Loads session history, wires {@link useChat} (client-side tools), and renders
 * UIMessage parts via {@link BotMessage}. Tool execution is invisible to this
 * screen except through streaming part states on assistant messages.
 */

type SessionData = InferResponseType<(typeof apiClient.sessions)[":id"]["$get"], 200>;

function ChatMessage(
  { msg, streaming = false }: {
    msg: Message
    streaming?: boolean
  }
) {
  if (msg.role === "user") {
    const text = msg.parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("");

    return <UserMessage message={text} mode={msg.metadata?.mode ?? "BUILD"} />;
  }

  return (
    <BotMessage
      parts={msg.parts}
      model={msg.metadata?.model ?? "unknown"}
      mode={msg.metadata?.mode ?? "BUILD"}
      durationMs={msg.metadata?.durationMs}
      streaming={streaming}
    />
  );
};

function SessionChat({ 
  session,
  initialPrompt,
}: { 
  session: SessionData,
  initialPrompt?: { message: string; mode: ModeType; model: SupportedChatModelId };
}) {
  const [initialMessages] = useState(() => parseInitialMessages(session.messages));
  const { mode, model } = usePromptConfig();
  const { isTopLayer } = useKeyboardLayer();
  const { messages, status, submit, abort, interrupt, error } = useChat(
    session.id,
    initialMessages
  );
  const hasSubmittedInitialPromptRef = useRef(false);

  useEffect(() => {
    return initMcpOnSessionMount(process.cwd());
  }, []);

  // Stop the pending reply when the user leaves this session.
  useEffect(() => {
    return () => {
      void abort();
    };
  }, [abort]);

  // Let the user cancel a reply even before the first streamed chunk arrives.
  useKeyboard((key) => {
    if (key.name === "escape" && isTopLayer("base") && status === "streaming") {
      key.preventDefault();
      interrupt();
    }
  });

  useEffect(() => {
    if (!initialPrompt || hasSubmittedInitialPromptRef.current) return;
    hasSubmittedInitialPromptRef.current = true;
    void submit({
      userText: initialPrompt.message,
      mode: initialPrompt.mode,
      model: initialPrompt.model,
    });
  }, [initialPrompt, submit]);

  return (
    <SessionShell
      onSubmit={(text) => submit({ userText: text, mode, model })}
      loading={status === "submitted" || status === "streaming"}
      interruptible={status === "submitted" || status === "streaming"}
    >
      {messages.map((msg, index) => (
        <ChatMessage
          key={msg.id}
          msg={msg}
          streaming={
            (status === "submitted" || status === "streaming") &&
            index === messages.length - 1 &&
            msg.role === "assistant"
          }
        />
      ))}
      {error && <ErrorMessage message={error.message} />}
    </SessionShell>
  );
}

export function Session() {
  const { id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();

  const prefetched = useMemo(() => {
    const parsed = sessionLocationSchema.safeParse(location.state);
    if (!parsed.success) return null;
    return {
      session: parsed.data.session as SessionData,
      initialPrompt: parsed.data.initialPrompt,
      local: parsed.data.local,
    };
  }, [location.state]);

  const [session, setSession] = useState<SessionData | null>(prefetched?.session ?? null);

  useEffect(() => {
    // Skip fetch if session was passed via location state
    if (prefetched?.session) return;

    setSession(null);

    if (!id) return;

    let ignore = false;

    if (isLocalMode() || prefetched?.local) {
      const localSession = getLocalSession(id);
      if (ignore) return;
      if (!localSession) {
        toast.show({
          variant: "error",
          message: "Local session not found",
        });
        navigate("/", { replace: true });
        return;
      }
      setSession(localSession as SessionData);
      return;
    }

    const fetchSession = async () => {
      try {
        const res = await apiClient.sessions[":id"].$get({ 
          param: { id },
        });
        if (ignore) return;
        if (!res.ok) throw new Error(await getErrorMessage(res));
        const resolved = await res.json();
        setSession(resolved);
      } catch (err) {
        if (ignore) return;
        toast.show({
          variant: "error",
          message: err instanceof Error ? err.message : "Failed to load session",
        });
        navigate("/", { replace: true });
      }
    };

    fetchSession();
    return () => {
      ignore = true;
    };
  }, [id, prefetched, toast, navigate]);

  if (!session) {
    return <SessionShell onSubmit={() => {}} inputDisabled loading />;
  }

  return (
    <SessionChat 
      key={session.id} 
      session={session} 
      initialPrompt={prefetched?.initialPrompt}
    />
  );
};