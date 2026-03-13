import assert from "node:assert/strict";
import test from "node:test";

import { extractFilesFromDataTransfer } from "./data-transfer-files.js";

test("prefers dataTransfer.files when populated", () => {
  const fileA = { name: "a.png" } as File;
  const fileB = { name: "b.pdf" } as File;
  const transfer = {
    files: [fileA, fileB],
    items: [],
  } as unknown as DataTransfer;

  const result = extractFilesFromDataTransfer(transfer);
  assert.deepEqual(result, [fileA, fileB]);
});

test("falls back to file items when files is empty", () => {
  const fileA = { name: "from-item.png" } as File;
  const transfer = {
    files: [],
    items: [
      {
        kind: "file",
        getAsFile: () => fileA,
      },
      {
        kind: "string",
        getAsFile: () => null,
      },
      {
        kind: "file",
        getAsFile: () => null,
      },
    ],
  } as unknown as DataTransfer;

  const result = extractFilesFromDataTransfer(transfer);
  assert.deepEqual(result, [fileA]);
});

test("returns empty list for null transfer", () => {
  assert.deepEqual(extractFilesFromDataTransfer(null), []);
});
