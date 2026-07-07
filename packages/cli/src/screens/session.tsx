import { useState, useEffect, useMemo, useRef, useLayoutEffect } from "react";
import { useParams, useLocation, useNavigate } from "react-router";
import { useKeyboard } from "@opentui/react";
import type { ScrollBoxRenderable } from "@opentui/core";
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
import {
  resolveAutoResumeRequest,
} from "../lib/stream-interrupt";
import { resolvePreResponseEsc } from "../lib/composer-restore";
import { stripIncompleteAssistantMessages } from "../lib/local-chat-transport";
import {
  SessionChatActionsProvider,
  useRegisterSessionChatActions,
} from "../providers/session-chat-actions";
import { scrollToBottomAfterLayout, streamingTranscriptScrollSignal } from "../utils/list-scroll-nav";
import {
  shouldShowPendingTranscriptReply,
  transcriptHasPendingTask,
} from "../lib/slash-subagent-transcript";

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
      usage={msg.metadata?.usage}
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
  const { show: showToast } = useToast();
  const {
    messages,
    status,
    turnInterrupted,
    subagentRunning,
    subagentType,
    submit,
    abort,
    interrupt,
    error,
    continueGeneration,
    resumeStream,
    getEligibility,
    setMessages,
  } = useChat(session.id, initialMessages, {
    onPersistError: (message) => {
      showToast({ variant: "error", message });
    },
  });
  const hasSubmittedInitialPromptRef = useRef(false);
  const hasAutoResumedRef = useRef(false);
  const lastSubmittedTextRef = useRef("");
  const [composerRestoreText, setComposerRestoreText] = useState<string | null>(null);
  const [composerRestoreToken, setComposerRestoreToken] = useState(0);
  const transcriptScrollRef = useRef<ScrollBoxRenderable>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const sessionActions = useMemo(
    () => ({
      continueGeneration,
      resumeStream,
      getEligibility,
    }),
    [continueGeneration, resumeStream, getEligibility],
  );
  useRegisterSessionChatActions(sessionActions);

  const abortRef = useRef(abort);
  abortRef.current = abort;

  useEffect(() => {
    return initMcpOnSessionMount(process.cwd());
  }, []);

  // Stop in-flight generation when leaving session — skip when already idle.
  useEffect(() => {
    return () => {
      if (statusRef.current !== "submitted" && statusRef.current !== "streaming") return;
      void abortRef.current();
    };
  }, []);

  useEffect(() => {
    if (hasAutoResumedRef.current) return;
    const initialPromptPending = Boolean(
      initialPrompt && !hasSubmittedInitialPromptRef.current,
    );
    if (initialPromptPending) return;

    const resumeRequest = resolveAutoResumeRequest({
      messages,
      status,
      hasAutoResumed: hasAutoResumedRef.current,
      initialPromptPending,
      fallbackMode: mode,
      fallbackModel: model,
    });
    if (!resumeRequest) return;
    hasAutoResumedRef.current = true;
    void continueGeneration(resumeRequest);
  }, [messages, status, initialPrompt, continueGeneration, mode, model]);

  // Esc: interrupt streaming, or restore composer before first token (D-03).
  useKeyboard((key) => {
    if (key.name !== "escape" || !isTopLayer("base")) return;

    const escResult =
      status === "submitted" || status === "streaming"
        ? resolvePreResponseEsc({
            status,
            messages,
            lastSubmittedText: lastSubmittedTextRef.current,
          })
        : null;

    if (escResult) {
      key.preventDefault();
      interrupt();
      if (escResult.removeEmptyAssistant) {
        setMessages(stripIncompleteAssistantMessages(messages));
      }
      setComposerRestoreText(escResult.composerRestoreText);
      setComposerRestoreToken((token) => token + 1);
      return;
    }

    if (status === "streaming") {
      key.preventDefault();
      interrupt();
    }
  });

  useEffect(() => {
    if (!initialPrompt || hasSubmittedInitialPromptRef.current) return;
    hasSubmittedInitialPromptRef.current = true;
    lastSubmittedTextRef.current = initialPrompt.message;
    void submit({
      userText: initialPrompt.message,
      mode: initialPrompt.mode,
      model: initialPrompt.model,
    });
  }, [initialPrompt, submit]);

  const lastMessage = messages.at(-1);
  const isLoading =
    ((status === "submitted" || status === "streaming") && !turnInterrupted) ||
    subagentRunning;
  const hasPendingTaskInTranscript = transcriptHasPendingTask(messages);
  const pendingTranscriptReply = shouldShowPendingTranscriptReply({
    isLoading,
    lastMessageRole: lastMessage?.role,
    subagentRunning,
    hasPendingTaskInTranscript,
  });
  const pendingMode = lastMessage?.metadata?.mode ?? mode;
  const pendingModel = lastMessage?.metadata?.model ?? model;
  const transcriptScrollSignal = streamingTranscriptScrollSignal(isLoading, messages);

  // biome-ignore lint/correctness/useExhaustiveDependencies: transcriptScrollSignal re-scrolls during token streaming while isLoading stays true
  useLayoutEffect(() => {
    if (!isLoading) return;
    const scrollbox = transcriptScrollRef.current;
    if (!scrollbox) return;

    return scrollToBottomAfterLayout(scrollbox);
  }, [isLoading, transcriptScrollSignal]);

  return (
    <SessionShell
      onSubmit={(text) => {
        lastSubmittedTextRef.current = text;
        setComposerRestoreText(null);
        setComposerRestoreToken(0);
        void submit({ userText: text, mode, model });
      }}
      loading={isLoading}
      interruptible={isLoading}
      subagentRunning={subagentRunning}
      subagentType={subagentType}
      inputDisabled={isLoading}
      composerRestoreText={composerRestoreText}
      composerRestoreToken={composerRestoreToken}
      transcriptScrollRef={transcriptScrollRef}
    >
      {messages.map((msg, index) => (
        <ChatMessage
          key={msg.id}
          msg={msg}
          streaming={
            !turnInterrupted &&
            (status === "submitted" || status === "streaming") &&
            index === messages.length - 1 &&
            msg.role === "assistant"
          }
        />
      ))}
      {pendingTranscriptReply ? (
        <BotMessage
          parts={[]}
          model={pendingModel}
          mode={pendingMode}
          streaming
        />
      ) : null}
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
    if (prefetched?.session) return;

    if (!id) return;

    // Already showing this session — don't clear when router state is consumed.
    if (session?.id === id) return;

    setSession(null);

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
      setSession(localSession as unknown as SessionData);
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
  }, [id, prefetched?.local, prefetched?.session, session?.id, toast, navigate]);

  if (!session) {
    return <SessionShell onSubmit={() => {}} inputDisabled loading />;
  }

  return (
    <SessionChatActionsProvider>
      <SessionChat
        key={session.id}
        session={session}
        initialPrompt={prefetched?.initialPrompt}
      />
    </SessionChatActionsProvider>
  );
};
