type ErrorResponse = {
  json: () => Promise<unknown>;
  status: number;
  statusText: string;
};

/** HTTP failure that keeps the status code so callers can act on it. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Extract a human-readable message from the server's `{ error }` JSON envelope. */
export async function getErrorMessage(response: ErrorResponse) {
    try {
      const data = (await response.json()) as { error?: string };
      if (typeof data.error === "string" && data.error.length > 0) {
        return data.error;
      }
    } catch {
      // Ignore invalid error payloads and fall back to the status text below.
    }
  
    return response.statusText || `Request failed with status ${response.status}`;
  }
