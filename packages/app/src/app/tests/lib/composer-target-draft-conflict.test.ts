import assert from "node:assert/strict";
import test from "node:test";

import {
  composerDraftHasMeaningfulContent,
  draftPreviewText,
  resolveComposerTargetConflict,
} from "../../lib/composer-target-draft-conflict.js";
import type { ComposerDraft } from "../../types.js";

const draft = (text: string): ComposerDraft => ({
  mode: "prompt",
  parts: text ? [{ type: "text", text }] : [],
  attachments: [],
  text,
  resolvedText: text,
});

const fileAttachment = (name: string) => ({
  id: `attachment-${name}`,
  name,
  mimeType: "application/octet-stream",
  size: 1,
  kind: "file" as const,
  dataUrl: "data:application/octet-stream;base64,eA==",
});

test("composerDraftHasMeaningfulContent ignores whitespace-only text", () => {
  assert.equal(composerDraftHasMeaningfulContent(draft(" \n\t ")), false);
});

test("composerDraftHasMeaningfulContent treats text, attachments, and non-text parts as meaningful", () => {
  assert.equal(composerDraftHasMeaningfulContent(draft("Ship it")), true);
  assert.equal(
    composerDraftHasMeaningfulContent({
      ...draft(" \n "),
      resolvedText: "Resolved content",
    }),
    true,
  );
  assert.equal(
    composerDraftHasMeaningfulContent({
      ...draft(""),
      attachments: [fileAttachment("brief.txt")],
    }),
    true,
  );
  assert.equal(
    composerDraftHasMeaningfulContent({
      ...draft(""),
      parts: [{ type: "file", path: "/tmp/brief.md", label: "brief.md" }],
    }),
    true,
  );
});

test("resolveComposerTargetConflict selects obvious current or destination drafts", () => {
  assert.deepEqual(resolveComposerTargetConflict({ current: draft(""), destination: draft("old") }), {
    kind: "load-destination",
  });
  assert.deepEqual(resolveComposerTargetConflict({ current: draft("new"), destination: null }), {
    kind: "use-current",
  });
  assert.deepEqual(resolveComposerTargetConflict({ current: draft("same"), destination: draft("same") }), {
    kind: "load-destination",
  });
});

test("resolveComposerTargetConflict reports content conflicts", () => {
  assert.deepEqual(resolveComposerTargetConflict({ current: draft("new"), destination: draft("old") }), {
    kind: "conflict",
    currentPreview: "new",
    destinationPreview: "old",
  });
  assert.deepEqual(
    resolveComposerTargetConflict({
      current: {
        ...draft("same"),
        attachments: [fileAttachment("brief.pdf")],
      },
      destination: draft("same"),
    }),
    {
      kind: "conflict",
      currentPreview: "same",
      destinationPreview: "same",
    },
  );
});

test("draftPreviewText compacts whitespace and falls back to the first attachment name", () => {
  assert.equal(draftPreviewText(draft("one\n\n two\tthree")), "one two three");
  assert.equal(draftPreviewText({ ...draft(" \n "), resolvedText: "resolved\n\n text" }), "resolved text");
  assert.equal(
    draftPreviewText({
      ...draft(""),
      attachments: [fileAttachment("brief.pdf")],
    }),
    "brief.pdf",
  );
});
