/** Keep `index` visible inside a fixed-size list viewport (row count, not layout pixels). */
export function scrollIndexIntoView(
  scrollbox: { scrollTop: number; scrollTo: (position: number) => void },
  index: number,
  pageSize: number,
): void {
  if (pageSize <= 0) return;

  const scrollTop = scrollbox.scrollTop;
  if (index < scrollTop) {
    scrollbox.scrollTo(index);
    return;
  }

  const lastVisible = scrollTop + pageSize - 1;
  if (index > lastVisible) {
    scrollbox.scrollTo(index - pageSize + 1);
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

export function visibleItemCount(itemCount: number, maxVisible: number): number {
  return Math.min(itemCount, maxVisible);
}
