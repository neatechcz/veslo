import assert from "node:assert/strict";
import test from "node:test";

import {
  extractFileReferencePathsFromDataTransfer,
  extractFilesFromDataTransfer,
  isFileDragTransfer,
} from "../../utils/data-transfer-files.js";

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

test("detects file drags from the Files transfer type even before files resolve", () => {
  const transfer = {
    files: [],
    types: ["Files", "text/plain"],
  } as unknown as DataTransfer;

  assert.equal(isFileDragTransfer(transfer), true);
});

test("does not treat plain text drags as file transfers", () => {
  const transfer = {
    files: [],
    types: ["text/plain"],
  } as unknown as DataTransfer;

  assert.equal(isFileDragTransfer(transfer), false);
});

test("extracts file reference paths from URI list drop data", () => {
  const files = [{ name: "large spec.pdf", size: 9 * 1024 * 1024 }] as File[];
  const transfer = {
    getData: (type: string) => {
      if (type === "text/uri-list") return "file:///Users/example/Documents/large%20spec.pdf";
      return "";
    },
  };

  const result = extractFileReferencePathsFromDataTransfer(transfer, files);

  assert.equal(result.get(files[0]), "/Users/example/Documents/large spec.pdf");
});

test("prefers non-standard File.path when the webview exposes it", () => {
  const files = [
    {
      name: "archive.zip",
      size: 12 * 1024 * 1024,
      path: "/Users/example/Downloads/archive.zip",
    },
  ] as unknown as File[];

  const result = extractFileReferencePathsFromDataTransfer(null, files);

  assert.equal(result.get(files[0]), "/Users/example/Downloads/archive.zip");
});

test("matches native clipboard file paths to pasted files when the webview omits local paths", () => {
  const files = [
    { name: "meeting.mov", size: 22 * 1024 * 1024 },
    { name: "brief.pdf", size: 9 * 1024 * 1024 },
  ] as File[];
  const transfer = {
    getData: () => "",
  };

  const result = extractFileReferencePathsFromDataTransfer(transfer, files, [
    "/Users/example/Desktop/brief.pdf",
    "/Users/example/Movies/meeting.mov",
  ]);

  assert.equal(result.get(files[0]), "/Users/example/Movies/meeting.mov");
  assert.equal(result.get(files[1]), "/Users/example/Desktop/brief.pdf");
});
