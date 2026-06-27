import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHAT_MODEL_ID, findSupportedChatModel } from "@mocode/shared";
import { saveKeys } from "./keys";
import { setLocalMode } from "./local-mode";
import { openKeysWizardIfNeeded, shouldAutoOpenKeysWizard } from "./keys-wizard-trigger";

const TEST_DIR = join(homedir(), ".mocode-test-keys-wizard");

function defaultProvider(): string {
  return findSupportedChatModel(DEFAULT_CHAT_MODEL_ID)!.provider;
}

describe("shouldAutoOpenKeysWizard", () => {
  beforeEach(() => {
    setLocalMode(false);
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
    }
  });

  afterEach(() => {
    setLocalMode(false);
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("returns true when local mode and keys missing", () => {
    setLocalMode(true);
    const provider = defaultProvider();
    expect(shouldAutoOpenKeysWizard({ keysDir: TEST_DIR, provider })).toBe(true);
  });

  test("returns false in SaaS mode", () => {
    setLocalMode(false);
    expect(shouldAutoOpenKeysWizard({ keysDir: TEST_DIR, provider: defaultProvider() })).toBe(false);
  });

  test("returns false when keys present", () => {
    setLocalMode(true);
    const provider = defaultProvider();
    saveKeys({ [provider]: { apiKey: "sk-test-key" } }, { keysDir: TEST_DIR });
    expect(shouldAutoOpenKeysWizard({ keysDir: TEST_DIR, provider })).toBe(false);
  });
});

describe("openKeysWizardIfNeeded", () => {
  beforeEach(() => {
    setLocalMode(false);
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true, mode: 0o700 });
    }
  });

  afterEach(() => {
    setLocalMode(false);
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  test("opens dialog when local mode and keys missing", () => {
    setLocalMode(true);
    const provider = defaultProvider();
    let opened = false;

    const dialog = {
      open: () => {
        opened = true;
      },
      close: () => {},
    };

    expect(openKeysWizardIfNeeded(dialog, { keysDir: TEST_DIR, provider })).toBe(true);
    expect(opened).toBe(true);
  });

  test("does not open dialog in SaaS mode", () => {
    setLocalMode(false);
    let opened = false;

    const dialog = {
      open: () => {
        opened = true;
      },
      close: () => {},
    };

    expect(openKeysWizardIfNeeded(dialog, { keysDir: TEST_DIR, provider: defaultProvider() })).toBe(
      false,
    );
    expect(opened).toBe(false);
  });
});
