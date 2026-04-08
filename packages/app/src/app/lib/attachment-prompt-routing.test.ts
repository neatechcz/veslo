import assert from "node:assert/strict";
import test from "node:test";

import type { ComposerAttachment, ComposerDraft, ModelRef, ProviderListItem } from "../types";
import { routeStagedAttachmentsForModel } from "./attachment-prompt-routing.js";

const buildProviders = (): ProviderListItem[] => [
  {
    id: "opencode",
    name: "OpenCode",
    env: [],
    models: {
      "minimax-m2.5-free": {
        id: "minimax-m2.5-free",
        name: "MiniMax M2.5 Free",
        release_date: "",
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
        modalities: { input: ["text"], output: ["text"] },
        options: {},
      },
      "gpt-4.1": {
        id: "gpt-4.1",
        name: "GPT-4.1",
        release_date: "",
        attachment: true,
        reasoning: true,
        temperature: true,
        tool_call: true,
        limit: { context: 128000, output: 8192 },
        modalities: { input: ["text", "image"], output: ["text"] },
        options: {},
      },
    },
  },
] as ProviderListItem[];

const baseDraft = (attachments: ComposerAttachment[]): ComposerDraft => ({
  mode: "prompt",
  parts: [{ type: "text", text: "Co je na screenshotu?" }],
  attachments,
  text: "Co je na screenshotu?",
  resolvedText: "Co je na screenshotu?",
});

const imageAttachment: ComposerAttachment = {
  id: "att-image",
  name: "Screenshot 2026-04-08 at 10.17.50.png",
  mimeType: "image/png",
  size: 1024,
  kind: "image",
  dataUrl: "data:image/png;base64,AAAA",
};

const docAttachment: ComposerAttachment = {
  id: "att-doc",
  name: "brief.docx",
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  size: 2048,
  kind: "file",
  dataUrl: "data:application/octet-stream;base64,BBBB",
};

test("vision-capable models keep image attachments inline without leaking staged screenshot names into prompt text", () => {
  const model: ModelRef = { providerID: "opencode", modelID: "gpt-4.1" };
  const result = routeStagedAttachmentsForModel({
    draft: baseDraft([imageAttachment]),
    stagedAttachments: [
      {
        name: imageAttachment.name,
        kind: "image",
        mimeType: imageAttachment.mimeType,
        relativePath: imageAttachment.name,
        absolutePath: `/workspace/${imageAttachment.name}`,
      },
    ],
    model,
    providers: buildProviders(),
  });

  assert.equal(result.system, undefined);
  assert.equal(result.error, undefined);
  assert.equal(result.draft.resolvedText, "Co je na screenshotu?");
  assert.deepEqual(result.draft.attachments, [imageAttachment]);
});

test("non-vision prompt models reject image attachments instead of relying on a read-tool fallback", () => {
  const model: ModelRef = { providerID: "opencode", modelID: "minimax-m2.5-free" };
  const result = routeStagedAttachmentsForModel({
    draft: baseDraft([imageAttachment]),
    stagedAttachments: [
      {
        name: imageAttachment.name,
        kind: "image",
        mimeType: imageAttachment.mimeType,
        relativePath: imageAttachment.name,
        absolutePath: `/workspace/${imageAttachment.name}`,
      },
    ],
    model,
    providers: buildProviders(),
  });

  assert.equal(result.draft.resolvedText, "Co je na screenshotu?");
  assert.deepEqual(result.draft.attachments, [imageAttachment]);
  assert.equal(result.system, undefined);
  assert.match(result.error ?? "", /cannot inspect image attachments/i);
  assert.doesNotMatch(result.draft.resolvedText ?? "", /Screenshot 2026-04-08 at 10\.17\.50\.png/);
});

test("non-image attachments still append staged paths into the prompt for editability", () => {
  const model: ModelRef = { providerID: "opencode", modelID: "minimax-m2.5-free" };
  const result = routeStagedAttachmentsForModel({
    draft: baseDraft([docAttachment]),
    stagedAttachments: [
      {
        name: docAttachment.name,
        kind: "file",
        mimeType: docAttachment.mimeType,
        relativePath: `session/${docAttachment.name}`,
        absolutePath: `/workspace/session/${docAttachment.name}`,
      },
    ],
    model,
    providers: buildProviders(),
  });

  assert.equal(result.system, undefined);
  assert.equal(result.error, undefined);
  assert.match(result.draft.resolvedText ?? "", /Co je na screenshotu\?\nsession\/brief\.docx$/);
  assert.deepEqual(result.draft.attachments, [docAttachment]);
});

test("shell mode keeps staged image paths in the command text instead of relying on model-only system fallback", () => {
  const model: ModelRef = { providerID: "opencode", modelID: "minimax-m2.5-free" };
  const result = routeStagedAttachmentsForModel({
    draft: {
      ...baseDraft([imageAttachment]),
      mode: "shell",
      text: "ls",
      resolvedText: "ls",
    },
    stagedAttachments: [
      {
        name: imageAttachment.name,
        kind: "image",
        mimeType: imageAttachment.mimeType,
        relativePath: `session/${imageAttachment.name}`,
        absolutePath: `/workspace/session/${imageAttachment.name}`,
      },
    ],
    model,
    providers: buildProviders(),
  });

  assert.equal(result.system, undefined);
  assert.equal(result.error, undefined);
  assert.match(result.draft.resolvedText ?? "", /^ls\nsession\/Screenshot 2026-04-08 at 10\.17\.50\.png$/);
  assert.deepEqual(result.draft.attachments, [imageAttachment]);
});
