import { For, Show } from "solid-js";

import type { ManagedAiSelectableModel } from "../../lib/ai-access";
import type { ModelRef } from "../../types";

export type SessionModelSelectorProps = {
  enabled: boolean;
  models: ManagedAiSelectableModel[];
  selectedModel: ModelRef | null;
  selectionUnavailable?: boolean;
  disabled?: boolean;
  label: string;
  defaultLabel: string;
  imageCapableLabel: string;
  imageUnsupportedLabel: string;
  imageUnknownLabel: string;
  selectionUnavailableMessage: string;
  onSelect: (model: ModelRef | null) => void;
};

function modelValue(model: ModelRef): string {
  return `${model.providerID}:${model.modelID}`;
}

export default function SessionModelSelector(props: SessionModelSelectorProps) {
  const selectedValue = () => props.selectedModel ? modelValue(props.selectedModel) : "";

  const optionLabel = (entry: ManagedAiSelectableModel): string => {
    const supportsImage = entry.capabilityStatus === "known" &&
      (entry.attachment === true || entry.modalities?.input?.includes("image"));
    if (supportsImage) return `${entry.model.modelID} \u00b7 ${props.imageCapableLabel}`;
    if (entry.capabilityStatus === "unknown") return `${entry.model.modelID} \u00b7 ${props.imageUnknownLabel}`;
    return `${entry.model.modelID} \u00b7 ${props.imageUnsupportedLabel}`;
  };

  const selectModel = (value: string) => {
    const model = props.models.find((entry) => modelValue(entry.model) === value)?.model ?? null;
    props.onSelect(model);
  };

  return (
    <>
      <Show when={props.enabled && props.models.length > 1}>
        <label class="flex w-full max-w-[960px] items-center justify-end gap-2 text-xs text-gray-9">
          <span>{props.label}</span>
          <select
            aria-label={props.label}
            data-testid="session-model-selector"
            class="rounded-lg border border-gray-6 bg-gray-1 px-2 py-1 text-xs text-gray-12"
            value={selectedValue()}
            disabled={props.disabled}
            onInput={(event) => selectModel(event.currentTarget.value)}
          >
            <option value="">{props.defaultLabel}</option>
            <For each={props.models}>
              {(entry) => (
                <option value={modelValue(entry.model)}>
                  {optionLabel(entry)}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>
      <Show when={props.enabled && props.selectionUnavailable}>
        <p class="mt-1 text-right text-xs text-amber-10" data-testid="session-model-selector-unavailable" role="status">
          {props.selectionUnavailableMessage}
        </p>
      </Show>
    </>
  );
}
