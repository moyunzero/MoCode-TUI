/**
 * BYOK keys gate (Phase 02, D-12).
 *
 * Auto-opens the `/keys` wizard once on cold start when `shouldAutoOpenKeysWizard()`
 * is true (local mode + missing provider key). `didAutoOpenRef` prevents re-open loops
 * when the user dismisses the dialog — the effect must not re-fire on DialogProvider
 * context identity changes after close.
 */
import { createElement, useEffect, useRef } from "react";
import { KeysWizardDialogContent } from "./dialogs/keys-wizard-dialog";
import { shouldAutoOpenKeysWizard } from "../lib/keys-wizard-trigger";
import { useDialog } from "../providers/dialog";

/** Mount-time D-12 gate: auto-opens `/keys` wizard once when BYOK keys are missing. */
export function KeysSetupGate() {
  const { open } = useDialog();
  const didAutoOpenRef = useRef(false);

  useEffect(() => {
    if (didAutoOpenRef.current || !shouldAutoOpenKeysWizard()) {
      return;
    }
    didAutoOpenRef.current = true;
    open({
      title: "API Keys",
      children: createElement(KeysWizardDialogContent),
    });
  }, [open]);

  return null;
}
