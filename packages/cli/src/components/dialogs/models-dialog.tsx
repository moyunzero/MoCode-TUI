import { useCallback, useMemo } from "react";
import {
  formatModelCatalogHint,
  getModelCatalogHint,
  sortModelsForCatalogPicker,
  type SupportedChatModelId,
} from "@mocode/shared";
import { useDialog } from "../../providers/dialog";
import { useTheme } from "../../providers/theme";
import { DialogSearchList } from "../dialog-search-list";

type ModelsDialogContentProps = {
    /** Full allow-list passed from COMMANDS (SUPPORTED_CHAT_MODELS ids). */
    models: SupportedChatModelId[];
    /** Writes into PromptConfigProvider via the slash-command action context. */
    onSelectModel: (model:SupportedChatModelId) => void;
}

/** Searchable picker opened by `/models`; commits model id on Enter and closes the dialog. */
export const ModelsDialogContent = ({
    models,
    onSelectModel,
}: ModelsDialogContentProps) => {
  const dialog = useDialog();
  const { colors } = useTheme();

  const sortedModels = useMemo(() => sortModelsForCatalogPicker(models), [models]);

  const handleSelect = useCallback(
    (modelId: SupportedChatModelId) => {
      onSelectModel(modelId);
      dialog.close();
    },
    [onSelectModel, dialog],
  );

  return (
    <DialogSearchList
      items={sortedModels}
      onSelect={handleSelect}
      filterFn={(modelId, query) => {
        const normalized = query.toLowerCase();
        if (modelId.toLowerCase().includes(normalized)) {
          return true;
        }
        const hint = getModelCatalogHint(modelId);
        return hint ? formatModelCatalogHint(hint).includes(query) : false;
      }}
      renderItem={(modelId, isSelected) => {
        const hint = getModelCatalogHint(modelId);
        const hintColor =
          hint === "free-recommended"
            ? isSelected
              ? "black"
              : colors.success
            : hint === "weak-tools"
              ? isSelected
                ? "black"
                : colors.error
              : isSelected
                ? "black"
                : "gray";

        return (
          <box flexDirection="row" gap={1}>
            <text selectable={false} fg={isSelected ? "black" : "white"}>
              {modelId}
            </text>
            {hint ? (
              <text selectable={false} fg={hintColor}>
                {formatModelCatalogHint(hint)}
              </text>
            ) : null}
          </box>
        );
      }}
      getKey={(modelId) => modelId.toString()}
      placeholder="Search models..."
      emptyText="No models found"
    />
  );
};