/**
 * Context budget + compaction.
 *
 * Problem: the server replays the whole stored session on every turn, so the prompt
 * grows without bound. A long session eventually either overflows the model window
 * or costs a fortune in input tokens for history nobody re-reads.
 *
 * Approach: when the estimated prompt exceeds a budget, keep the most recent turns
 * verbatim and replace everything older with a compact deterministic digest. The
 * digest is not an LLM summary on purpose — it adds no latency, no cost, and no
 * extra failure mode, and what the agent actually needs from old turns is *what it
 * already did* (tools used, files touched), not the prose around it.
 *
 * Pure module: no I/O, no model calls.
 */

/** Rough token estimate. ASCII ≈ 4 chars/token; CJK ≈ 1 char/token. */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;

  let narrow = 0;
  let wide = 0;

  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // CJK, kana, hangul and full-width forms are ~1 token per character.
    if (code > 0x2e80) wide += 1;
    else narrow += 1;
  }

  return Math.ceil(narrow / 4) + wide;
}

type PartLike = {
  type: string;
  text?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
};

type MessageLike = {
  id: string;
  role: string;
  parts?: unknown;
};

function partsOf(message: MessageLike): PartLike[] {
  return Array.isArray(message.parts) ? (message.parts as PartLike[]) : [];
}

/** Token estimate for one message, counting text and tool payloads. */
export function estimateMessageTokens(message: MessageLike): number {
  let total = 0;

  for (const part of partsOf(message)) {
    if (typeof part.text === "string") total += estimateTextTokens(part.text);
    if (part.input !== undefined) total += estimateTextTokens(safeJson(part.input));
    if (part.output !== undefined) total += estimateTextTokens(safeJson(part.output));
    // Fixed overhead per part keeps a long tool-call chain from looking free.
    total += 4;
  }

  return total;
}

/** Token estimate for a whole conversation. */
export function estimateMessagesTokens(messages: MessageLike[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Tool name for a part, handling both static `tool-<name>` and dynamic MCP calls. */
function toolNameOf(part: PartLike): string | null {
  if (part.type === "dynamic-tool" && typeof part.toolName === "string") return part.toolName;
  if (part.type.startsWith("tool-")) return part.type.slice("tool-".length);
  return null;
}

/** File-path-ish strings inside a tool input, for the digest. */
function pathsIn(input: unknown, into: Set<string>): void {
  if (input === null || typeof input !== "object") return;

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (/path|file|dir/i.test(key) && !value.includes("\n") && value.length <= 120) {
        into.add(value);
      }
    } else if (value !== null && typeof value === "object") {
      pathsIn(value, into);
    }
  }
}

export type CompactionPolicy = {
  /** Estimated prompt tokens allowed before compaction runs. */
  maxTokens: number;
  /** Most recent messages kept verbatim. */
  keepRecent: number;
  /** Below this many messages compaction is pointless — skip it. */
  minMessages: number;
};

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  maxTokens: 60_000,
  keepRecent: 10,
  minMessages: 16,
};

export type CompactionResult<MESSAGE extends MessageLike> = {
  messages: MESSAGE[];
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
  /** Human-readable record of what was folded away; null when nothing happened. */
  digest: string | null;
};

/**
 * Fold old turns into one digest message when the prompt exceeds `maxTokens`.
 *
 * The cut is placed on a user-message boundary so a tool call and its result are
 * never separated — splitting those would produce an invalid conversation.
 */
export function compactMessages<MESSAGE extends MessageLike>(
  messages: MESSAGE[],
  policy: CompactionPolicy = DEFAULT_COMPACTION_POLICY,
): CompactionResult<MESSAGE> {
  const tokensBefore = estimateMessagesTokens(messages);

  const noop: CompactionResult<MESSAGE> = {
    messages,
    compacted: false,
    tokensBefore,
    tokensAfter: tokensBefore,
    digest: null,
  };

  if (tokensBefore <= policy.maxTokens) return noop;
  if (messages.length < policy.minMessages) return noop;

  const cut = findCutIndex(messages, policy.keepRecent);
  if (cut <= 0) return noop;

  const dropped = messages.slice(0, cut);
  const kept = messages.slice(cut);
  const digest = buildDigest(dropped);

  const digestMessage = {
    id: `compaction-${dropped.length}`,
    role: "assistant",
    parts: [{ type: "text", text: digest }],
  } as unknown as MESSAGE;

  const compacted = [digestMessage, ...kept];
  const tokensAfter = estimateMessagesTokens(compacted);

  return {
    messages: compacted,
    compacted: true,
    tokensBefore,
    tokensAfter,
    digest,
  };
}

/**
 * Index to cut at: far enough back to keep `keepRecent` messages, snapped forward
 * to the next user message so no assistant/tool group is split.
 */
function findCutIndex(messages: MessageLike[], keepRecent: number): number {
  const target = Math.max(1, messages.length - keepRecent);

  // Prefer a boundary at or after the target: keeps the most recent turns intact.
  for (let index = target; index < messages.length; index += 1) {
    if (messages[index]?.role === "user") return index;
  }

  // No user boundary ahead — fall back to the closest one *before* it. Returning
  // `target` would cut inside a turn and could drop the user's active request.
  for (let index = Math.min(target, messages.length - 1); index >= 1; index -= 1) {
    if (messages[index]?.role === "user") return index;
  }

  // Nothing safe to remove; compaction is skipped rather than guessed.
  return 0;
}

/** Deterministic record of what the dropped turns did. */
function buildDigest(dropped: MessageLike[]): string {
  const toolCounts = new Map<string, number>();
  const paths = new Set<string>();
  let userTurns = 0;

  for (const message of dropped) {
    if (message.role === "user") userTurns += 1;

    for (const part of partsOf(message)) {
      const toolName = toolNameOf(part);
      if (toolName) {
        toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1);
        pathsIn(part.input, paths);
      }
    }
  }

  const tools = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}×${count}`)
    .join(", ");

  const fileList = [...paths].slice(0, 12).join(", ");

  const lines = [
    `[compacted] ${dropped.length} earlier messages folded away (${userTurns} user turns).`,
    tools ? `Tools already used: ${tools}.` : null,
    fileList ? `Files touched: ${fileList}.` : null,
    "Those turns are no longer in context; re-read a file if you need its exact contents.",
  ].filter(Boolean);

  return lines.join(" ");
}
