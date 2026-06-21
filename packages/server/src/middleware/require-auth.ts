/**
 * Hono middleware that gates protected API routes behind Clerk OAuth.
 *
 * On success, sets `c.get("userId")` for downstream handlers. On failure,
 * returns 401 with a CLI-friendly message pointing users to `/login`.
 */
import { createMiddleware } from "hono/factory";
import { authenticateOAuthRequest } from "../lib/auth";

/** Hono context typing: authenticated routes can read `userId` from Variables. */
export type AuthenticatedEnv = {
  Variables: {
    userId: string;
  };
};

export const requireAuth = createMiddleware<AuthenticatedEnv>(async (c, next) => {
  try {
    const auth = await authenticateOAuthRequest(c.req.raw);
    if (!auth) {
      return c.json({ error: "Unauthorized. Run /login to continue." }, 401);
    }

    c.set("userId", auth.userId);
    await next();
  } catch {
    return c.json({ error: "Unauthorized. Run /login to continue." }, 401);
  }
});
