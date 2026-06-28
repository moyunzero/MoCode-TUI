import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CHAT_MODEL_ID, findSupportedChatModel } from "@mocode/shared";
import { saveKeys } from "./keys";
import { setLocalMode } from "./local-mode";
import { openKeysWizardIfNeeded, shouldAutoOpenKeysWizard } from "./keys-wizard-trigger";

let testDir: string;

function defaultProvider(): string {
  return findSupportedChatModel(DEFAULT_CHAT_MODEL_ID)!.provider;
}

describe("shouldAutoOpenKeysWizard", () => {
  beforeEach(() => {
    setLocalMode(false);
    testDir = mkdtempSync(join(tmpdir(), "mocode-test-keys-wizard-"));
  });

  afterEach(() => {
    setLocalMode(false);
    rmSync(testDir, { recursive: true, force: true });
  });

  test("returns true when local mode and keys missing", () => {
    setLocalMode(true);
    const provider = defaultProvider();
    expect(shouldAutoOpenKeysWizard({ keysDir: testDir, provider })).toBe(true);
  });

  test("returns false in SaaS mode", () => {
    setLocalMode(false);
    expect(shouldAutoOpenKeysWizard({ keysDir: testDir, provider: defaultProvider() })).toBe(false);
  });

  test("returns false when keys present", () => {
    setLocalMode(true);
    const provider = defaultProvider();
    saveKeys({ [provider]: { apiKey: "sk-test-key" } }, { keysDir: testDir });
    expect(shouldAutoOpenKeysWizard({ keysDir: testDir, provider })).toBe(false);
  });
});

describe("openKeysWizardIfNeeded", () => {
  beforeEach(() => {
    setLocalMode(false);
    testDir = mkdtempSync(join(tmpdir(), "mocode-test-keys-wizard-"));
  });

  afterEach(() => {
    setLocalMode(false);
    rmSync(testDir, { recursive: true, force: true });
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

    expect(openKeysWizardIfNeeded(dialog, { keysDir: testDir, provider })).toBe(true);
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

    expect(openKeysWizardIfNeeded(dialog, { keysDir: testDir, provider: defaultProvider() })).toBe(
      false,
    );
    expect(opened).toBe(false);
  });
});
