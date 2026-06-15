import { hc } from "hono/client";
import type { AppType } from "@mocode/server";

/** Type-safe RPC client; routes and payloads are inferred from the Hono server. */
export const apiClient = hc<AppType>(process.env.API_URL ?? "http://localhost:3000");