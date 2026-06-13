import type { ModelOption, ModelRef, ProviderListItem } from "../types.js";
import { modelEquals, resolveModelLabelParts } from "../utils/index.js";

type ModelPickerOptionLabels = {
  default: string;
  reasoning: string;
  disconnected: string;
};

type BuildModelPickerOptionsInput = {
  providers: ProviderListItem[];
  providerDefaults: Record<string, string>;
  connectedProviderIds: string[];
  currentDefault: ModelRef;
  currentSelection: ModelRef;
  labels: ModelPickerOptionLabels;
};

const appendFooterBit = (footer: string | undefined, bit: string) => {
  const trimmedBit = bit.trim();
  if (!trimmedBit) return footer;
  const bits = (footer ?? "")
    .split("·")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!bits.includes(trimmedBit)) bits.push(trimmedBit);
  return bits.length ? bits.join(" · ") : undefined;
};

const buildPinnedCurrentSelection = (
  currentSelection: ModelRef,
  currentDefault: ModelRef,
  providers: ProviderListItem[],
  labels: ModelPickerOptionLabels,
): ModelOption => {
  const { providerLabel, modelLabel } = resolveModelLabelParts(currentSelection, providers);
  let footer = appendFooterBit(undefined, labels.disconnected);
  if (modelEquals(currentSelection, currentDefault)) {
    footer = appendFooterBit(footer, labels.default);
  }

  return {
    providerID: currentSelection.providerID,
    modelID: currentSelection.modelID,
    title: modelLabel,
    description: providerLabel,
    footer,
    isFree: false,
    isConnected: false,
    keepVisibleWhenDisconnected: true,
  };
};

export function buildModelPickerOptions(input: BuildModelPickerOptionsInput): ModelOption[] {
  const { providers, providerDefaults, connectedProviderIds, currentDefault, currentSelection, labels } = input;
  if (!providers.length) {
    return [buildPinnedCurrentSelection(currentSelection, currentDefault, providers, labels)];
  }

  const sortedProviders = providers.slice().sort((a, b) => {
    const aIsOpencode = a.id === "opencode";
    const bIsOpencode = b.id === "opencode";
    if (aIsOpencode !== bIsOpencode) return aIsOpencode ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const next: ModelOption[] = [];

  for (const provider of sortedProviders) {
    const defaultModelID = providerDefaults[provider.id];
    const isConnected = connectedProviderIds.includes(provider.id);
    const models = Object.values(provider.models ?? {}).filter(
      (model) => model.status !== "deprecated",
    );

    models.sort((a, b) => {
      const aFree = a.cost?.input === 0 && a.cost?.output === 0;
      const bFree = b.cost?.input === 0 && b.cost?.output === 0;
      if (aFree !== bFree) return aFree ? -1 : 1;
      return (a.name ?? a.id).localeCompare(b.name ?? b.id);
    });

    for (const model of models) {
      const isFree = model.cost?.input === 0 && model.cost?.output === 0;
      const isDefault =
        provider.id === currentDefault.providerID && model.id === currentDefault.modelID;
      let footer: string | undefined;
      if (defaultModelID === model.id || isDefault) {
        footer = appendFooterBit(footer, labels.default);
      }
      if (model.capabilities.reasoning) {
        footer = appendFooterBit(footer, labels.reasoning);
      }

      next.push({
        providerID: provider.id,
        modelID: model.id,
        title: model.name ?? model.id,
        description: provider.name,
        footer,
        disabled: !isConnected,
        isFree,
        isConnected,
      });
    }
  }

  const selectedIndex = next.findIndex((option) => modelEquals(option, currentSelection));
  if (selectedIndex === -1) {
    next.unshift(buildPinnedCurrentSelection(currentSelection, currentDefault, providers, labels));
  } else if (!next[selectedIndex]?.isConnected) {
    next[selectedIndex] = {
      ...next[selectedIndex],
      footer: appendFooterBit(next[selectedIndex]?.footer, labels.disconnected),
      keepVisibleWhenDisconnected: true,
    };
  }

  next.sort((a, b) => {
    if (a.keepVisibleWhenDisconnected !== b.keepVisibleWhenDisconnected) {
      return a.keepVisibleWhenDisconnected ? -1 : 1;
    }
    if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
    if (a.isFree !== b.isFree) return a.isFree ? -1 : 1;
    return a.title.localeCompare(b.title);
  });

  return next;
}
