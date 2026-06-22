/**
 * Billing HTTP routes backed by Polar.sh (Phase 10).
 *
 * POST /billing/checkout  — authenticated; returns Polar checkout URL for `/upgrade`
 * POST /billing/portal    — authenticated; returns customer portal URL for `/usage`
 * GET  /billing/success   — public landing page after checkout/portal (browser tab)
 *
 * Auth for checkout/portal is applied in index.ts; success stays public.
 */
import { Hono } from "hono";
import type { AuthenticatedEnv } from "../middleware/require-auth";
import { createCheckoutUrl, createCustomerPortalUrl } from "../lib/polar";

const app = new Hono<AuthenticatedEnv>()
  .post("/checkout", async (c) => {
    const userId = c.get("userId");

    return c.json({
      url: await createCheckoutUrl({ customerExternalId: userId, requestUrl: c.req.url }),
    });
  })
  .post("/portal", async (c) => {
    const userId = c.get("userId");

    return c.json({
      url: await createCustomerPortalUrl({ customerExternalId: userId, requestUrl: c.req.url }),
    });
  })
  .get("/success", (c) => c.text("Done. You can close this tab and return to mocode."));

export default app;
