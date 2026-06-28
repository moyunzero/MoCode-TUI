/** Leading-ellipsis truncation for long paths in terminal UI (DESIGN.md). */
export function truncatePathForDisplay(path: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (path.length <= maxWidth) return path;
  if (maxWidth === 1) return "…";
  return `…${path.slice(-(maxWidth - 1))}`;
}
