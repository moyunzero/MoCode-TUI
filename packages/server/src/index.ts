import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import sessions from "./routes/sessions";

const app = new Hono();

// Normalize API errors to `{ error: string }` so the CLI can parse them consistently.
app.onError((err, c) => {
    if (err instanceof HTTPException) {
        return c.json({ error: err.message || "Request failed" }, err.status);
    };

    console.error("Unhandled error:", err);
    return c.json({ error: "Internal Server Error" }, 500);
});

const routes = app.route("/sessions", sessions);

/** Exported for type-safe Hono RPC client generation in the CLI. */
export type AppType = typeof routes;

export default {
    port: 3000,
    fetch: app.fetch,
    // Bun default idle timeout is too low for slow DB calls during development.
    idleTimeout: 255,
};