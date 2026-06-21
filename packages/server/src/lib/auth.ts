/**
 * Server-side Clerk OAuth token verification.
 *
 * Validates `Authorization: Bearer <token>` headers using Clerk's
 * `authenticateRequest` with `acceptsToken: "oauth_token"`. Returns the
 * authenticated Clerk user id for session/chat ownership checks.
 */
import { createClerkClient } from "@clerk/backend";

if (!process.env.CLERK_SECRET_KEY) {
  throw new Error("CLERK_SECRET_KEY environment variable is required");
}

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  throw new Error("CLERK_PUBLISHABLE_KEY environment variable is required");
}

const clerkClient = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
  publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
});

/**
 * Parses and validates the incoming request's OAuth bearer token.
 * Returns `{ userId }` on success, or `null` when the token is missing/invalid.
 */
export async function authenticateOAuthRequest(request: Request) {
  const requestState = await clerkClient.authenticateRequest(request, {
    acceptsToken: "oauth_token",
  });

  if (!requestState.isAuthenticated) {
    return null;
  }

  const auth = requestState.toAuth();
  if (auth.tokenType !== "oauth_token" || !auth.userId) {
    return null;
  }

  return { userId: auth.userId };
};
