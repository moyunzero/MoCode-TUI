/**
 * Browser-based OAuth login for the CLI (Clerk + PKCE).
 *
 * ## Why a two-hop redirect?
 *
 * Clerk only allows fixed redirect URIs registered in the dashboard (e.g.
 * `http://localhost:3000/auth/callback`). The CLI cannot register a unique
 * localhost port per login attempt, so the flow is:
 *
 *   1. CLI starts a temporary localhost server on a random port.
 *   2. Browser opens Clerk authorize URL with `redirect_uri` pointing at the
 *      Hono API (`/auth/callback`) and `state` encoding the CLI callback port.
 *   3. Clerk redirects to the API; the API relays `code` + `state` to the CLI
 *      server (`http://localhost:<port>/callback`).
 *   4. CLI verifies `state.nonce`, exchanges the code for tokens via Clerk's
 *      token endpoint, and saves the access token locally.
 *
 * PKCE (`code_verifier` / `code_challenge`) protects the authorization code
 * exchange because the CLI is a public OAuth client with no client secret.
 */
import open from "open";
import { saveAuth } from "./auth";

/** Abandon login if the user never completes the browser flow. */
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

/** Serialized into the OAuth `state` param and echoed back on callback. */
type OAuthState = {
  /** Random value bound to this login attempt; prevents CSRF replay. */
  nonce: string;
  /** Ephemeral port of the CLI's local callback server. */
  port: number;
};

function toBase64Url(input: Uint8Array | string) {
  return Buffer.from(input).toString("base64url");
}

/** SHA-256 hash of the PKCE verifier, sent as `code_challenge` (S256). */
async function createPkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return toBase64Url(new Uint8Array(digest));
}

function encodeState(state: OAuthState) {
  return toBase64Url(JSON.stringify(state));
}

function decodeState(state: string) {
  const [encoded] = state.split(".");
  if (!encoded) {
    throw new Error("Invalid state");
  }

  return JSON.parse(Buffer.from(encoded, "base64url").toString()) as OAuthState;
}

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Opens the system browser for Clerk sign-in and resolves when tokens are saved.
 * Rejects on timeout, user cancellation, or token exchange failure.
 */
export async function performLogin() {
  const clerkFrontendApi = process.env.CLERK_FRONTEND_API;
  const clientId = process.env.CLERK_OAUTH_CLIENT_ID;
  const apiUrl = process.env.API_URL ?? "http://localhost:3000";

  if (!clerkFrontendApi) throw new Error("CLERK_FRONTEND_API not set");
  if (!clientId) throw new Error("CLERK_OAUTH_CLIENT_ID not set");

  const nonce = crypto.randomUUID();
  const codeVerifier = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const codeChallenge = await createPkceChallenge(codeVerifier);

  // Tracks whether the Promise has already resolved/rejected (timeout vs callback race).
  let settled = false;

  return new Promise<{ token: string }>((resolve, reject) => {
    // Ephemeral server receives the relayed authorization code from the API.
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname !== "/callback") {
          return new Response("Not found", { status: 404 });
        }

        const error = url.searchParams.get("error");

        if (error) {
          const msg = url.searchParams.get("error_description") ?? error;
          settled = true;
          reject(new Error(msg));
          setTimeout(() => server.stop(), 500);
          return new Response(`Authentication failed: ${msg}`, { status: 400 });
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code || !state) {
          settled = true;
          reject(new Error("Missing code or state"));
          setTimeout(() => server.stop(), 500);
          return new Response("Bad request", { status: 400 });
        }

        // Verify the callback belongs to this login attempt (not a forged redirect).
        try {
          const payload = decodeState(state);

          if (payload.nonce !== nonce) throw new Error("State mismatch");
        } catch (err) {
          settled = true;
          reject(err);
          setTimeout(() => server.stop(), 500);
          return new Response("Invalid state", { status: 400 });
        }

        try {
          // Exchange authorization code for Clerk tokens (PKCE verifier proves ownership).
          const redirectUri = `${apiUrl}/auth/callback`;

          const tokenRes = await fetch(`${clerkFrontendApi}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "authorization_code",
              code,
              redirect_uri: redirectUri,
              client_id: clientId,
              code_verifier: codeVerifier,
            }),
          });

          if (!tokenRes.ok) {
            const details = await tokenRes.text();
            throw new Error(details || "Failed to exchange authorization code");
          }

          const tokenData = (await tokenRes.json()) as { access_token: string };

          settled = true;
          saveAuth({ token: tokenData.access_token });
          resolve({ token: tokenData.access_token });
          setTimeout(() => server.stop(), 500);
          return new Response("Authenticated! You can close this tab.");
        } catch (err) {
          settled = true;
          reject(err);
          const message = getErrorMessage(err);
          setTimeout(() => server.stop(), 500);
          return new Response(`Authentication failed: ${message}`, { status: 400 });
        }
      },
    });

    // Embed the CLI callback port in state so the API relay knows where to forward.
    const port = server.port;
    if (typeof port !== "number") {
      server.stop();
      reject(new Error("Failed to start callback server"));
      return;
    }

    const state = encodeState({ port, nonce });
    const redirectUri = `${apiUrl}/auth/callback`;

    const authorizeUrl = new URL(`${clerkFrontendApi}/oauth/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "openid email profile");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("prompt", "login");
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    void open(authorizeUrl.toString());

    setTimeout(() => {
      if (!settled) {
        settled = true;
        server.stop();
        reject(new Error("Login timed out"));
      }
    }, LOGIN_TIMEOUT_MS)
  });
}
