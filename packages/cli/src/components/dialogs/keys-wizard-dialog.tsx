/**
 * `/keys` BYOK API key wizard (Phase 02, D-12).
 *
 * Two views: provider list (masked key preview) → edit form (paste key, save to keys.json).
 * Keys never leave the machine; chmod 600 on `~/.mocode/keys.json`.
 */
import { TextAttributes, type InputRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState } from "react";
import { moveDialogSelection } from "../../lib/dialog-action-nav";
import { getKeys, saveKeys, type ProviderKeys } from "../../lib/keys";
import { useKeyboardLayer } from "../../providers/keyboard-layer";
import { useTheme } from "../../providers/theme";
import { useToast } from "../../providers/toast";
import { DialogSearchList } from "../dialog-search-list";

const PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "cerebras",
  "openrouter",
] as const;

type ProviderId = (typeof PROVIDERS)[number];

type WizardView = "list" | "edit";

const EDIT_ACTION_COUNT = 2;

function maskApiKey(apiKey: string): string {
  if (apiKey.length === 0) {
    return "not set";
  }
  if (apiKey.length <= 4) {
    return "••••";
  }
  return `${apiKey.slice(0, 4)}${"•".repeat(Math.min(8, apiKey.length - 4))}`;
}

function getProviderLabel(provider: ProviderId): string {
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

type ActionButtonProps = {
  label: string;
  hint?: string;
  selected?: boolean;
  onSelect: () => void;
  onMouseMove?: () => void;
};

function ActionButton({ label, hint, selected, onSelect, onMouseMove }: ActionButtonProps) {
  const { colors } = useTheme();

  return (
    <box
      flexDirection="row"
      paddingX={1}
      height={1}
      backgroundColor={selected ? colors.selection : undefined}
      onMouseMove={onMouseMove}
      onMouseDown={onSelect}
    >
      <text selectable={false} fg={selected ? "black" : "white"} attributes={TextAttributes.BOLD}>
        {label}
      </text>
      {hint ? (
        <text selectable={false} fg={selected ? "black" : "gray"}>
          {" "}
          {hint}
        </text>
      ) : null}
    </box>
  );
}

/** Multi-provider API key wizard opened by `/keys` (D-12). */
export function KeysWizardDialogContent() {
  const { isTopLayer } = useKeyboardLayer();
  const { show } = useToast();
  const [view, setView] = useState<WizardView>("list");
  const [keys, setKeys] = useState<ProviderKeys>(() => getKeys() ?? {});
  const [editingProvider, setEditingProvider] = useState<ProviderId | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [actionIndex, setActionIndex] = useState(0);
  const inputRef = useRef<InputRenderable>(null);

  const handleSelectProvider = useCallback(
    (provider: ProviderId) => {
      setEditingProvider(provider);
      setDraftKey(keys[provider]?.apiKey ?? "");
      setActionIndex(0);
      setView("edit");
    },
    [keys],
  );

  const handleBack = useCallback(() => {
    setView("list");
    setEditingProvider(null);
    setDraftKey("");
  }, []);

  const handleSaveKey = useCallback(() => {
    if (!editingProvider) {
      return;
    }

    const nextKeys = { ...keys };
    const trimmed = draftKey.trim();

    if (trimmed.length === 0) {
      delete nextKeys[editingProvider];
    } else {
      nextKeys[editingProvider] = { apiKey: trimmed };
    }

    try {
      saveKeys(nextKeys);
      setKeys(nextKeys);
      handleBack();
    } catch (error) {
      show({
        variant: "error",
        message: error instanceof Error ? error.message : "Failed to save API key",
      });
    }
  }, [keys, editingProvider, draftKey, handleBack, show]);

  const handleContentChange = useCallback(() => {
    setDraftKey(inputRef.current?.value ?? "");
  }, []);

  useKeyboard((key) => {
    if (!isTopLayer("dialog") || view !== "edit") {
      return;
    }

    if (key.name === "escape") {
      handleBack();
    } else if (key.name === "return" || key.name === "enter") {
      key.preventDefault();
      if (actionIndex === 0) {
        handleSaveKey();
      } else {
        handleBack();
      }
    } else if (key.name === "up") {
      key.preventDefault();
      setActionIndex((index) => moveDialogSelection(index, "up", EDIT_ACTION_COUNT));
    } else if (key.name === "down") {
      key.preventDefault();
      setActionIndex((index) => moveDialogSelection(index, "down", EDIT_ACTION_COUNT));
    }
  });

  if (view === "list") {
    return (
      <box flexDirection="column" gap={1}>
        <text attributes={TextAttributes.DIM}>
          Select a provider to configure. Saved keys show a masked preview only.
        </text>
        <DialogSearchList
          items={[...PROVIDERS]}
          onSelect={handleSelectProvider}
          filterFn={(provider, query) =>
            getProviderLabel(provider).toLowerCase().includes(query.toLowerCase())
          }
          renderItem={(provider, isSelected) => (
            <box flexDirection="row" gap={1} paddingX={1}>
              <text selectable={false} fg={isSelected ? "black" : "white"}>
                {getProviderLabel(provider)}
              </text>
              <text
                selectable={false}
                fg={isSelected ? "black" : "gray"}
                attributes={TextAttributes.DIM}
              >
                {maskApiKey(keys[provider]?.apiKey ?? "")}
              </text>
            </box>
          )}
          getKey={(provider) => provider}
          placeholder="Search providers..."
          emptyText="No providers found"
        />
        <text attributes={TextAttributes.DIM}>Esc to close</text>
      </box>
    );
  }

  const providerLabel = editingProvider ? getProviderLabel(editingProvider) : "Provider";
  const actions = [
    { label: "Save key", hint: "(Enter)", onSelect: handleSaveKey },
    { label: "Back", hint: "(Esc)", onSelect: handleBack },
  ] as const;

  return (
    <box flexDirection="column" gap={1}>
      <text attributes={TextAttributes.DIM}>API key for {providerLabel}</text>
      <input
        ref={inputRef}
        placeholder="Paste API key..."
        focused
        value={draftKey}
        onContentChange={handleContentChange}
      />
      <text attributes={TextAttributes.DIM}>
        Preview: {draftKey.length > 0 ? "•".repeat(Math.min(draftKey.length, 12)) : "(empty)"}
      </text>
      <box flexDirection="column" gap={0}>
        {actions.map((action, index) => (
          <ActionButton
            key={action.label}
            label={action.label}
            hint={action.hint}
            selected={index === actionIndex}
            onSelect={action.onSelect}
            onMouseMove={() => setActionIndex(index)}
          />
        ))}
      </box>
    </box>
  );
}
