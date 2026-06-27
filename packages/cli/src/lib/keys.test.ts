import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { saveKeys, getKeys, hasRequiredKeys } from "./keys";

const TEST_DIR = join(homedir(), ".mocode-test-keys");
const KEYS_FILE = join(TEST_DIR, "keys.json");

describe("keys", () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
    }
  });

  afterEach(() => {
    if (existsSync(KEYS_FILE)) {
      rmSync(KEYS_FILE);
    }
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("saveKeys creates file with mode 0o600 per D-12", () => {
    saveKeys({ openai: { apiKey: "sk-test-key" } }, { keysDir: TEST_DIR });

    expect(existsSync(KEYS_FILE)).toBe(true);
    const stat = statSync(KEYS_FILE);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test("getKeys returns saved keys", () => {
    const keys = {
      anthropic: { apiKey: "sk-ant-test" },
      openai: { apiKey: "sk-test" },
    };
    saveKeys(keys, { keysDir: TEST_DIR });

    expect(getKeys({ keysDir: TEST_DIR })).toEqual(keys);
  });

  test("getKeys returns null when file missing", () => {
    expect(getKeys({ keysDir: TEST_DIR })).toBeNull();
  });

  test("hasRequiredKeys returns true when provider has non-empty apiKey", () => {
    saveKeys({ openai: { apiKey: "sk-test" } }, { keysDir: TEST_DIR });
    expect(hasRequiredKeys("openai", { keysDir: TEST_DIR })).toBe(true);
  });

  test("hasRequiredKeys returns false when provider missing or empty", () => {
    saveKeys({ openai: { apiKey: "" } }, { keysDir: TEST_DIR });
    expect(hasRequiredKeys("openai", { keysDir: TEST_DIR })).toBe(false);
    expect(hasRequiredKeys("anthropic", { keysDir: TEST_DIR })).toBe(false);
  });
});
