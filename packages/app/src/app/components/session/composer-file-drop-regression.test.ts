import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");

test("unsupported dropped files do not inject file links into the prompt body", () => {
  assert.doesNotMatch(
    source,
    /insertUnsupportedFileLinks\(/,
    "composer should not auto-insert path or blob links for unsupported dropped files",
  );
});

test("composer does not gate attachments by MIME allow-list", () => {
  assert.doesNotMatch(
    source,
    /isSupportedAttachmentType\(/,
    "composer should not reject attachments by MIME type",
  );

  assert.doesNotMatch(
    source,
    /session\.unsupported_attachment_type/,
    "composer should not show unsupported-type errors when user drops valid files",
  );
});

test("composer exposes a dedicated file-drag hover state for drop feedback", () => {
  assert.match(
    source,
    /const \[fileDragOver, setFileDragOver\] = createSignal\(false\);/,
    "composer should track file drag hover state for explicit drop feedback",
  );

  assert.match(
    source,
    /onDragEnter=\{/,
    "composer should register drag-enter handler for file hover feedback",
  );

  assert.match(
    source,
    /<Show when=\{fileDragOver\(\)\}>/,
    "composer should render a visible hover state when files are dragged over the composer",
  );
});
