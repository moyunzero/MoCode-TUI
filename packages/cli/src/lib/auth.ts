/**
 * CLI-side OAuth token persistence.
 *
 * Stores the Clerk access token in `~/.mocode/auth.json` so subsequent API
 * requests can attach `Authorization: Bearer <token>`. File permissions are
 * restricted to the current user because the token grants full API access.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type AuthData = {
  token: string;
};

const AUTH_DIR = join(homedir(), ".mocode");
const AUTH_FILE = join(AUTH_DIR, "auth.json");

/** Returns the saved token, or `null` when the user is signed out or the file is corrupt. */
export function getAuth(): AuthData | null {
  try {
    const data = readFileSync(AUTH_FILE, "utf-8");
    const parsed = JSON.parse(data) as Partial<AuthData>;
    return typeof parsed.token === "string" ? { token: parsed.token } : null;
  } catch {
    return null;
  }
};

/** Persists a token after a successful `/login` OAuth exchange. */
export function saveAuth(data: AuthData) {
  if (!existsSync(AUTH_DIR)) {
    // Owner-only permissions (rwx------) so other users on the machine can't read tokens
    mkdirSync(AUTH_DIR, { mode: 0o700 });
  }
  writeFileSync(AUTH_FILE, JSON.stringify(data), { mode: 0o600 });
}

/** Removes the stored token (used by `/logout` and when the API returns 401). */
export function clearAuth() {
  try {
    unlinkSync(AUTH_FILE);
  } catch {
    // File doesn't exist
  }
}
