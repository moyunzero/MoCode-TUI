/**
 * BYOK API key persistence (D-12).
 *
 * Stores provider keys in `~/.mocode/keys.json` with owner-only permissions.
 * Key values are never logged or included in thrown errors.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const providerKeySchema = z.object({
  apiKey: z.string(),
});

export const keysSchema = z.record(z.string(), providerKeySchema);

export type ProviderKeys = z.infer<typeof keysSchema>;

export type KeysOptions = {
  keysDir?: string;
};

const CONFIG_DIR = join(homedir(), ".mocode");

function resolveKeysFile(options?: KeysOptions): string {
  const dir = options?.keysDir ?? CONFIG_DIR;
  return join(dir, "keys.json");
}

function redactApiKeys(message: string, keys: ProviderKeys): string {
  let redacted = message;
  for (const entry of Object.values(keys)) {
    if (entry.apiKey.length > 0) {
      redacted = redacted.split(entry.apiKey).join("[REDACTED]");
    }
  }
  return redacted;
}

/** Returns saved provider keys, or `null` when the file is missing or invalid. */
export function getKeys(options?: KeysOptions): ProviderKeys | null {
  const keysFile = resolveKeysFile(options);
  try {
    const data = readFileSync(keysFile, "utf-8");
    const parsed = keysSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Persists provider keys after validation. Creates `~/.mocode` with mode 0o700 when needed. */
export function saveKeys(keys: ProviderKeys, options?: KeysOptions): void {
  const dir = options?.keysDir ?? CONFIG_DIR;
  const keysFile = join(dir, "keys.json");
  const parsed = keysSchema.safeParse(keys);

  if (!parsed.success) {
    throw new Error(redactApiKeys(parsed.error.message, keys));
  }

  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700 });
  } else {
    chmodSync(dir, 0o700);
  }

  writeFileSync(keysFile, JSON.stringify(parsed.data, null, 2), { mode: 0o600 });
  chmodSync(keysFile, 0o600);
}

/** Returns whether the given provider has a non-empty API key on disk. */
export function hasRequiredKeys(provider: string, options?: KeysOptions): boolean {
  const keys = getKeys(options);
  const entry = keys?.[provider];
  return typeof entry?.apiKey === "string" && entry.apiKey.length > 0;
}
