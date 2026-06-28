/** Keep `index` visible inside a fixed-size list viewport (row count, not layout pixels). */
export function scrollIndexIntoView(
  scrollbox: { scrollTop: number; scrollTo: (position: number) => void },
  index: number,
  pageSize: number,
  itemRowHeight = 1,
): void {
  if (pageSize <= 0) return;

  const scrollTop = scrollbox.scrollTop;
  const viewportRows = pageSize * itemRowHeight;
  const itemTop = index * itemRowHeight;
  const itemBottom = itemTop + itemRowHeight - 1;

  if (itemTop < scrollTop) {
    scrollbox.scrollTo(itemTop);
    return;
  }

  const lastVisibleRow = scrollTop + viewportRows - 1;
  if (itemBottom > lastVisibleRow) {
    scrollbox.scrollTo(Math.max(0, itemBottom - viewportRows + 1));
  }
}

/** Run scroll after OpenTUI has measured scrollbox content (needed on first mount). */
export function scrollIndexIntoViewAfterLayout(
  scrollbox: { scrollTop: number; scrollTo: (position: number) => void },
  index: number,
  pageSize: number,
): () => void {
  let outer: ReturnType<typeof setTimeout> | undefined;
  let inner: ReturnType<typeof setTimeout> | undefined;
  outer = setTimeout(() => {
    inner = setTimeout(() => {
      scrollIndexIntoView(scrollbox, index, pageSize);
    }, 0);
  }, 0);
  return () => {
    if (outer !== undefined) clearTimeout(outer);
    if (inner !== undefined) clearTimeout(inner);
  };
}

type ScrollboxLike = {
  scrollHeight: number;
  scrollTo: (position: number | { x: number; y: number }) => void;
  viewport: { height: number };
};

/** Pin transcript to the latest content after OpenTUI measures new rows. */
export function scrollToBottomAfterLayout(scrollbox: ScrollboxLike): () => void {
  let outer: ReturnType<typeof setTimeout> | undefined;
  let inner: ReturnType<typeof setTimeout> | undefined;
  outer = setTimeout(() => {
    inner = setTimeout(() => {
      const maxTop = Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height);
      scrollbox.scrollTo(maxTop);
    }, 0);
  }, 0);
  return () => {
    if (outer !== undefined) clearTimeout(outer);
    if (inner !== undefined) clearTimeout(inner);
  };
}

export function visibleItemCount(itemCount: number, maxVisible: number): number {
  return Math.min(itemCount, maxVisible);
}

type TranscriptMessage = {
  parts?: unknown;
};

/**
 * Monotonic signal for follow-scroll while streaming — grows when the tail message
 * gains text even if `messages.length` and `isLoading` stay constant.
 */
export function streamingTranscriptScrollSignal(
  isLoading: boolean,
  messages: ReadonlyArray<TranscriptMessage>,
): number {
  if (!isLoading) return 0;

  const last = messages.at(-1);
  if (!last || !Array.isArray(last.parts)) return messages.length;

  let signal = messages.length;
  for (const part of last.parts) {
    if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
      signal += part.text.length;
    } else {
      signal += 1;
    }
  }
  return signal;
}
