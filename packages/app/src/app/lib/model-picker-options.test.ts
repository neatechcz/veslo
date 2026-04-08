import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ModelRef, ProviderListItem } from "../types.js";
import { buildModelPickerOptions } from "./model-picker-options.js";

const modelPickerModalSource = readFileSync(new URL("../components/model-picker-modal.tsx", import.meta.url), "utf8");

const GPT_54: ModelRef = {
  providerID: "openai",
  modelID: "gpt-5.4",
};

const baseLabels = {
  default: "Default",
  reasoning: "Reasoning",
  disconnected: "Disconnected",
};

const buildProvider = (input: {
  id: string;
  name: string;
  models: Array<{ id: string; name?: string; reasoning?: boolean; free?: boolean; status?: "deprecated" | "alpha" | "beta" }>;
}): ProviderListItem => ({
  id: input.id,
  name: input.name,
  env: [],
  models: Object.fromEntries(
    input.models.map((model) => [
      model.id,
      {
        id: model.id,
        name: model.name ?? model.id,
        family: "",
        release_date: "",
        attachment: false,
        reasoning: model.reasoning ?? false,
        temperature: false,
        tool_call: true,
        cost: {
          input: model.free ? 0 : 1,
          output: model.free ? 0 : 1,
          cache_read: 0,
          cache_write: 0,
        },
        limit: {
          context: 128_000,
          output: 8_192,
        },
        options: {},
        status: model.status,
      },
    ]),
  ),
});

test("keeps the current selection when provider data is unavailable", () => {
  const options = buildModelPickerOptions({
    providers: [],
    providerDefaults: {},
    connectedProviderIds: [],
    currentDefault: GPT_54,
    currentSelection: GPT_54,
    labels: baseLabels,
  });

  assert.equal(options.length, 1);
  assert.deepEqual(
    options[0] && {
      providerID: options[0].providerID,
      modelID: options[0].modelID,
      keepVisibleWhenDisconnected: options[0].keepVisibleWhenDisconnected,
      isConnected: options[0].isConnected,
    },
    {
      providerID: "openai",
      modelID: "gpt-5.4",
      keepVisibleWhenDisconnected: true,
      isConnected: false,
    },
  );
});

test("shows the pinned current selection when the catalog no longer lists that model", () => {
  const options = buildModelPickerOptions({
    providers: [
      buildProvider({
        id: "openai",
        name: "OpenAI",
        models: [{ id: "gpt-4.1", name: "GPT-4.1" }],
      }),
    ],
    providerDefaults: {},
    connectedProviderIds: ["openai"],
    currentDefault: GPT_54,
    currentSelection: GPT_54,
    labels: baseLabels,
  });

  assert.equal(options[0]?.providerID, "openai");
  assert.equal(options[0]?.modelID, "gpt-5.4");
  assert.equal(options[0]?.keepVisibleWhenDisconnected, true);
  assert.match(options[0]?.footer ?? "", /Disconnected/);
  assert.ok(options.some((option) => option.modelID === "gpt-4.1"));
});

test("does not duplicate the current selection when it is still available", () => {
  const options = buildModelPickerOptions({
    providers: [
      buildProvider({
        id: "openai",
        name: "OpenAI",
        models: [{ id: "gpt-5.4", name: "ChatGPT 5.4", reasoning: true }],
      }),
    ],
    providerDefaults: { openai: "gpt-5.4" },
    connectedProviderIds: ["openai"],
    currentDefault: GPT_54,
    currentSelection: GPT_54,
    labels: baseLabels,
  });

  assert.equal(options.filter((option) => option.providerID === "openai" && option.modelID === "gpt-5.4").length, 1);
  assert.equal(options[0]?.keepVisibleWhenDisconnected, undefined);
  assert.equal(options[0]?.isConnected, true);
});

test("modal keeps the pinned unavailable selection visible instead of collapsing it into provider setup links", () => {
  assert.match(
    modelPickerModalSource,
    /\.filter\(\(opt\) => opt\.isConnected \|\| opt\.keepVisibleWhenDisconnected\)/,
  );
  assert.match(
    modelPickerModalSource,
    /if \(opt\.keepVisibleWhenDisconnected\) continue;/,
  );
});
