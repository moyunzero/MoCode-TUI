/** Surfaces real stream/API errors in the TUI instead of AI SDK's generic mask. */
export function formatChatStreamError(error: unknown): string {
  if (error == null) {
    return "Unknown error";
  }
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
