import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../components/session/composer.tsx", import.meta.url), "utf8");
const enLocale = readFileSync(new URL("../../../../i18n/locales/en.ts", import.meta.url), "utf8");
const csLocale = readFileSync(new URL("../../../../i18n/locales/cs.ts", import.meta.url), "utf8");
const dataTransferSource = readFileSync(new URL("../../../utils/data-transfer-files.ts", import.meta.url), "utf8");

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

test("composer prevents browser file-open default before checking attachment availability", () => {
  assert.match(
    source,
    /const handleDragEnter = \(event: DragEvent\) => \{\s*if \(!isFileDragTransfer\(event\.dataTransfer\)\) return;\s*event\.preventDefault\(\);\s*if \(submitLocked\(\)\) return;\s*if \(attachmentsDisabled\(\)\) return;\s*fileDragDepth \+= 1;/s,
    "file drag enter should suppress the browser default even when submit is locked or attachments are unavailable",
  );

  assert.match(
    source,
    /onDragOver=\{\(event: DragEvent\) => \{\s*if \(!isFileDragTransfer\(event\.dataTransfer\)\) return;\s*event\.preventDefault\(\);\s*if \(submitLocked\(\)\) return;\s*if \(attachmentsDisabled\(\)\) return;/s,
    "file drag over should suppress browser navigation before it decides whether to show attachment hover UI",
  );

  assert.match(
    source,
    /const handleDrop = \(event: DragEvent\) => \{\s*if \(!event\.dataTransfer \|\| !isFileDragTransfer\(event\.dataTransfer\)\) return;\s*event\.preventDefault\(\);\s*clearFileDragState\(\);\s*if \(submitLocked\(\)\) return;/s,
    "file drop should clear drag state even when submit is locked",
  );
});

test("composer attachment validation toasts are localized", () => {
  for (const localeSource of [enLocale, csLocale]) {
    assert.match(localeSource, /"session\.attachment_exceeds_size_limit":/);
    assert.match(localeSource, /"session\.attachment_encoded_too_large":/);
    assert.match(localeSource, /"session\.attachment_invalid_pdf":/);
    assert.match(localeSource, /"session\.attachment_reference_inserted_for_large_file":/);
    assert.match(localeSource, /"session\.attachment_reference_unavailable_for_large_file":/);
  }

  assert.match(source, /translate\("session\.attachment_encoded_too_large",\s*\{\s*name:\s*file\.name\s*\}\)/);
  assert.match(source, /translate\("session\.attachment_invalid_pdf",\s*\{\s*name:\s*file\.name\s*\}\)/);
  assert.match(source, /translate\("session\.attachment_reference_inserted_for_large_file",/);
  assert.match(source, /translate\("session\.attachment_reference_unavailable_for_large_file",/);

  for (const hardcodedCopy of [
    "exceeds the 8MB limit",
    "over the {limit} inline limit",
    "is too large after encoding",
    "is not a valid PDF file",
  ]) {
    assert.equal(source.includes(hardcodedCopy), false, `unexpected hardcoded attachment copy: ${hardcodedCopy}`);
  }
});

test("oversized pasted or dropped files become file references instead of attachments", () => {
  assert.match(
    dataTransferSource,
    /extractFileReferencePathsFromDataTransfer/,
    "data transfer helpers should expose path extraction for file references",
  );

  assert.match(
    source,
    /const fileReferencePaths = extractFileReferencePathsFromDataTransfer\(transfer, files, nativeFilePaths\);/,
    "composer should resolve platform file paths before deciding whether to inline attachments",
  );

  assert.match(
    source,
    /if \(file\.size > MAX_ATTACHMENT_BYTES\) \{[\s\S]*insertFileReferencesAtSelection\(/s,
    "oversized files should be inserted as file references instead of attachment data",
  );

  assert.doesNotMatch(
    source,
    /if \(file\.size > MAX_ATTACHMENT_BYTES\) \{\s*props\.onToast\(translate\("session\.attachment_exceeds_size_limit"/s,
    "oversized file handling should no longer stop at the generic limit toast when a path reference is available",
  );
});

test("pasted files ask Tauri for native clipboard paths before large-file handling", () => {
  assert.match(
    source,
    /import \{[^}]*readClipboardFilePaths[^}]*\} from "\.\.\/\.\.\/lib\/tauri";/s,
    "composer should import the desktop clipboard file-path bridge",
  );

  assert.match(
    source,
    /const nativeFilePaths = await readClipboardFilePaths\(\);[\s\S]*await addAttachments\(allFiles, clipboard, nativeFilePaths\);/s,
    "paste handling should resolve native clipboard file paths before it evaluates oversized files",
  );
});

test("oversized file reference toasts mention the actual size and limit", () => {
  for (const localeSource of [enLocale, csLocale]) {
    assert.match(localeSource, /"session\.attachment_reference_inserted_for_large_file":/);
    assert.match(localeSource, /"session\.attachment_reference_unavailable_for_large_file":/);
  }

  assert.match(
    source,
    /formatFileSize\(file\.size\)/,
    "large-file toast should include the actual dropped or pasted file size",
  );
  assert.match(
    source,
    /formatFileSize\(MAX_ATTACHMENT_BYTES\)/,
    "large-file toast should include the configured inline attachment limit",
  );
});
