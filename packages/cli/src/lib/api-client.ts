import { hc } from "hono/client";
import type { AppType } from "@mocode/server";
import { clearAuth, getAuth } from "./auth";

/**
 * Type-safe RPC client with automatic auth header injection.
 *
 * Reads the saved OAuth token from `~/.mocode/auth.json` and attaches it as
 * `Authorization: Bearer …` on every request. Clears local auth on 401 so
 * the CLI can prompt the user to run `/login` again.
 */
export const apiClient = hc<AppType>(
  process.env.API_URL ?? "http://localhost:3000",
  {
    fetch: async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const headers = new Headers(init?.headers);
      const auth = getAuth();

      if (auth) {
        headers.set("Authorization", `Bearer ${auth.token}`);
      }

      const response = await fetch(input, { ...init, headers });
      // Token expired or revoked — drop stale credentials so the next call fails visibly.
      if (response.status === 401) {
        clearAuth();
      }

      return response;
    }
  }
);
