import { strict as assert } from "node:assert";
import test from "node:test";

import {
  choosePickerStartPath,
  selectedFolderContainsRequestedPath,
} from "../../lib/folder-access-request";

test("starts picker at requested directory when it exists", () => {
  const result = choosePickerStartPath({
    requestedPath: "/Users/me/Drive/NDA",
    existingDirectories: new Set(["/Users", "/Users/me", "/Users/me/Drive", "/Users/me/Drive/NDA"]),
  });
  assert.equal(result, "/Users/me/Drive/NDA");
});

test("falls back to nearest existing parent for missing leaf", () => {
  const result = choosePickerStartPath({
    requestedPath: "/Users/me/Drive/NDA/file.docx",
    existingDirectories: new Set(["/Users", "/Users/me", "/Users/me/Drive", "/Users/me/Drive/NDA"]),
  });
  assert.equal(result, "/Users/me/Drive/NDA");
});

test("falls back to filesystem root when root is the nearest existing parent", () => {
  const result = choosePickerStartPath({
    requestedPath: "/Users/me/Drive/NDA/file.docx",
    existingDirectories: new Set(["/"]),
  });
  assert.equal(result, "/");
});

test("accepts selected folder containing requested path", () => {
  assert.equal(
    selectedFolderContainsRequestedPath("/Users/me/Drive", "/Users/me/Drive/NDA/file.docx"),
    true,
  );
});

test("accepts filesystem root containing requested path", () => {
  assert.equal(selectedFolderContainsRequestedPath("/", "/Users/me/Drive/NDA/file.docx"), true);
});

test("rejects unrelated selected folder", () => {
  assert.equal(
    selectedFolderContainsRequestedPath("/Users/me/Other", "/Users/me/Drive/NDA/file.docx"),
    false,
  );
});
