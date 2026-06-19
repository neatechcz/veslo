import assert from "node:assert/strict";
import test from "node:test";

import {
  pickCollisionSafeName,
  splitFilenameForCollision,
  toWorkspaceRelativeFromSessionDir,
} from "../../lib/session-attachment-staging.js";

test("converts a session directory file to a workspace-relative path", () => {
  const result = toWorkspaceRelativeFromSessionDir({
    workspaceRoot: "/repo",
    sessionDirectory: "/repo/project-a",
    filename: "notes.md",
  });

  assert.equal(result, "project-a/notes.md");
});

test("accepts backslash separators in workspace paths", () => {
  const result = toWorkspaceRelativeFromSessionDir({
    workspaceRoot: "C:\\repo",
    sessionDirectory: "C:\\repo\\project-a\\drafts",
    filename: "screenshot.png",
  });

  assert.equal(result, "project-a/drafts/screenshot.png");
});

test("rejects a session directory outside the workspace root", () => {
  assert.throws(
    () =>
      toWorkspaceRelativeFromSessionDir({
        workspaceRoot: "/repo",
        sessionDirectory: "/other/place",
        filename: "notes.md",
      }),
    /outside workspace root/i,
  );
});

test("splits a filename into stem and extension", () => {
  assert.deepEqual(splitFilenameForCollision("archive.tar.gz"), {
    stem: "archive.tar",
    ext: ".gz",
  });

  assert.deepEqual(splitFilenameForCollision("README"), {
    stem: "README",
    ext: "",
  });
});

test("picks a collision-safe name with preserved extension", () => {
  const existingPaths = new Set(["docs/report.pdf", "docs/report (1).pdf"]);

  const result = pickCollisionSafeName({
    directoryRel: "docs",
    filename: "report.pdf",
    existingPaths,
  });

  assert.equal(result, "docs/report (2).pdf");
});

test("picks the original filename when there is no collision", () => {
  const result = pickCollisionSafeName({
    directoryRel: "docs",
    filename: "README",
    existingPaths: new Set(["docs/other-file"]),
  });

  assert.equal(result, "docs/README");
});

test("picks a collision-safe name without an extension", () => {
  const result = pickCollisionSafeName({
    directoryRel: "docs",
    filename: "README",
    existingPaths: new Set(["docs/README", "docs/README (1)"]),
  });

  assert.equal(result, "docs/README (2)");
});
