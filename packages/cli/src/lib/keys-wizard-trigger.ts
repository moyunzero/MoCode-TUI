/**
 * D-12 auto-trigger for the `/keys` setup wizard in BYOK mode.
 * Never logs key values.
 */
import { createElement } from "react";
import { DEFAULT_CHAT_MODEL_ID, findSupportedChatModel } from "@mocode/shared";
import { KeysWizardDialogContent } from "../components/dialogs/keys-wizard-dialog";
import type { DialogContextValue } from "../providers/dialog";
import { hasRequiredKeys, type KeysOptions } from "./keys";
import { isLocalMode } from "./local-mode";

export type KeysWizardTriggerOptions = KeysOptions & {
  provider?: string;
};

function getDefaultProviderForKeysCheck(): string {
  return findSupportedChatModel(DEFAULT_CHAT_MODEL_ID)?.provider ?? "anthropic";
}

/** Returns true when BYOK mode is active and the target provider has no API key. */
export function shouldAutoOpenKeysWizard(options?: KeysWizardTriggerOptions): boolean {
  if (!isLocalMode()) {
    return false;
  }

  const provider = options?.provider ?? getDefaultProviderForKeysCheck();
  return !hasRequiredKeys(provider, options);
}

/** Opens the keys wizard when auto-trigger conditions are met. Returns whether it opened. */
export function openKeysWizardIfNeeded(
  dialog: DialogContextValue,
  options?: KeysWizardTriggerOptions,
): boolean {
  if (!shouldAutoOpenKeysWizard(options)) {
    return false;
  }

  dialog.open({
    title: "API Keys",
    children: createElement(KeysWizardDialogContent),
  });
  return true;
}
