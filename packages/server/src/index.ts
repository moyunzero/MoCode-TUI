import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import sessions from "./routes/sessions";
import { sentry } from "@sentry/hono/bun";
import * as Sentry from "@sentry/hono/bun";
import chat from "./routes/chat";
import auth from "./routes/auth";
import { requireAuth } from "./middleware/require-auth";

const app = new Hono();

const sentryDsn = process.env.SENTRY_DSN;
const tracesSampleRate = Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? "1.0");

// Capture request traces, errors, and structured logs when Sentry is configured.
if (sentryDsn) {
    app.use(
        sentry(app, {
            dsn: sentryDsn,
            tracesSampleRate: Number.isFinite(tracesSampleRate) ? tracesSampleRate : 1.0,
            enableLogs: true,
            // To disable sending user data and HTTP bodies, uncomment the line below. For more info visit:
            // https://docs.sentry.io/platforms/javascript/guides/hono/configuration/options/#dataCollection
            // dataCollection: { userInfo: false, httpBodies: [] },
        }),
    );
}

// Manual smoke-test route to verify Sentry log, metric, and error ingestion in development.
// app.get("/debug-sentry", () => {
//     Sentry.logger.info("User triggered test error", {
//         action: "test_error_endpoint",
//     });
//     Sentry.metrics.count("test_counter", 1);
//     throw new Error("My first Sentry error!");
// });
  

// Normalize API errors to `{ error: string }` so the CLI can parse them consistently.
app.onError((err, c) => {
    if (err instanceof HTTPException) {
        // Expected HTTP failures (4xx) are logged at warn to avoid noise in error dashboards.
        Sentry.logger.warn("Handle HTTP error", {
            status: err.status,
            message: err.message || "Request failed",
            path: c.req.path,
            method: c.req.method,
        });

        return c.json({ error: err.message || "Request failed" }, err.status);
    };

    // Unexpected exceptions become 500 responses and error-level Sentry events.
    Sentry.logger.error("Unhandled error", {
        message: err instanceof Error ? err.message : "Internal Server Error",
        path: c.req.path,
        method: c.req.method,
    });

    return c.json({ error: "Internal Server Error" }, 500);
});

// Phase 9: protect data routes; /auth/callback stays public for OAuth relay.
app.use("/sessions", requireAuth);
app.use("/chat", requireAuth);

// Public OAuth relay at /auth/callback; authenticated session/chat routes below.
const routes = app
    .route("/auth", auth)
    .route("/sessions", sessions)
    .route("/chat", chat);

/** Exported for type-safe Hono RPC client generation in the CLI. */
export type AppType = typeof routes;

export default {
    port: 3000,
    fetch: app.fetch,
    // Bun default idle timeout is too low for slow DB calls during development.
    idleTimeout: 255,
};