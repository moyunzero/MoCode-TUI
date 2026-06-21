/**
 * Pre-flight credits gate for billable API routes (Phase 10).
 *
 * Runs after {@link requireAuth} so `userId` maps to Polar `externalCustomerId`.
 * Returns 402 when balance <= 0 (CLI should suggest `/upgrade`).
 * Returns 503 when Polar is unreachable — fail closed without charging.
 */
import { createMiddleware } from "hono/factory";
import type { AuthenticatedEnv } from "./require-auth";
import { getAvailableCreditsBalance } from "../lib/polar";

export const requireCreditsBalance = createMiddleware<AuthenticatedEnv>(async (c, next) => {
  try {
    const userId = c.get("userId");
    const creditsBalance = await getAvailableCreditsBalance(userId);

    if (creditsBalance <= 0) {
      return c.json({ error: "No credits remaining. Run /upgrade to buy more credits." }, 402);
    }

    await next();
  } catch {
    return c.json({ error: "Unable to verify credits balance right now." }, 503);
  }
});
