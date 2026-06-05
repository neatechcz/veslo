import assert from "node:assert/strict";
import test from "node:test";
import type { Part } from "@opencode-ai/sdk/v2/client";

import { buildMediaEvidenceForParts } from "./media-evidence-model.js";

const part = (id: string, value: Record<string, unknown>): Part =>
  ({ id, sessionID: "s1", messageID: "m1", ...value }) as any;

test("classifies inline image file parts as analyzed by default", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "message:m1",
    defaultKind: "analyzed",
    parts: [
      part("p1", {
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: "data:image/png;base64,AAAA",
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "analyzed");
  assert.equal(evidence[0]?.title, "screenshot.png");
  assert.equal(evidence[0]?.mime, "image/png");
  assert.equal(evidence[0]?.src, "data:image/png;base64,AAAA");
  assert.equal(evidence[0]?.status, "available");
});

test("extracts structured tool images", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p2",
    defaultKind: "analyzed",
    parts: [
      part("p2", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [{ data: "BBBB", mediaType: "image/png", alt: "Browser screenshot" }],
        },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "analyzed");
  assert.equal(evidence[0]?.title, "Browser screenshot");
  assert.equal(evidence[0]?.src, "data:image/png;base64,BBBB");
});

test("extracts mime from structured image string data urls without semicolons", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p2b",
    defaultKind: "analyzed",
    parts: [
      part("p2b", {
        type: "tool",
        tool: "browser_screenshot",
        state: { status: "completed", images: ["data:image/png,AAAA"] },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.mime, "image/png");
});

test("excludes svg from inline and structured image evidence", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "message:m2",
    defaultKind: "analyzed",
    parts: [
      part("p2c", {
        type: "file",
        mime: "image/svg+xml",
        filename: "icon.svg",
        url: "data:image/svg+xml;base64,AAAA",
      }),
      part("p2d", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [{ data: "BBBB", mediaType: "image/svg+xml", alt: "Vector preview" }],
        },
      }),
      part("p2e", {
        type: "tool",
        tool: "browser_screenshot",
        state: { status: "completed", images: ["data:image/svg+xml;base64,AAAA"] },
      }),
    ],
  });

  assert.deepEqual(evidence, []);
});

test("classifies concrete created bitmap paths from write-like tools", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3",
    workspaceRoot: "/Users/me/project",
    parts: [
      part("p3", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "artifacts/result.webp" } },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "created");
  assert.equal(evidence[0]?.path, "artifacts/result.webp");
  assert.equal(evidence[0]?.src, "file:///Users/me/project/artifacts/result.webp");
});

test("does not create bitmap path evidence for unsuccessful write-like tool states", () => {
  for (const status of ["error", "failed", "running", "pending"]) {
    const evidence = buildMediaEvidenceForParts({
      sourceId: `tool:${status}`,
      workspaceRoot: "/Users/me/project",
      parts: [
        part(`p-${status}`, {
          type: "tool",
          tool: "write",
          state: { status, input: { filePath: "artifacts/result.png" } },
        }),
      ],
    });

    assert.deepEqual(evidence, []);
  }
});

test("keeps omitted write-like tool status eligible for historical created evidence", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3a",
    workspaceRoot: "/Users/me/project",
    parts: [
      part("p3a", {
        type: "tool",
        tool: "write",
        state: { input: { filePath: "artifacts/result.png" } },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.kind, "created");
});

test("encodes workspace file urls for paths with spaces", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3c",
    workspaceRoot: "/Users/me/AI agent projects/Veslo",
    parts: [
      part("p3c", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "artifacts/result image.png" } },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.src, "file:///Users/me/AI%20agent%20projects/Veslo/artifacts/result%20image.png");
});

test("formats windows absolute file urls", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3d",
    parts: [
      part("p3d", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "C:/Users/me/project/result.png" } },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.src, "file:///C:/Users/me/project/result.png");
});

test("formats windows workspace file urls for relative created paths", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3e",
    workspaceRoot: "C:/Users/me/project",
    parts: [
      part("p3e", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "artifacts/result.png" } },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.src, "file:///C:/Users/me/project/artifacts/result.png");
});

test("keeps ids unique when a tool has structured images and created bitmap paths", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3b",
    workspaceRoot: "/Users/me/project",
    parts: [
      part("p3b", {
        type: "tool",
        tool: "write",
        state: {
          status: "completed",
          images: [{ data: "CCCC", mediaType: "image/png", alt: "Generated preview" }],
          input: { filePath: "artifacts/result.png" },
        },
      }),
    ],
  });

  assert.equal(evidence.length, 2);
  assert.equal(evidence.some((item) => item.kind === "analyzed"), true);
  assert.equal(evidence.some((item) => item.kind === "created"), true);
  assert.equal(new Set(evidence.map((item) => item.id)).size, evidence.length);
});

test("ignores discovery-only tools and non-image files", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p4",
    parts: [
      part("p4", { type: "tool", tool: "grep", state: { input: { path: "images/logo.png" } } }),
      part("p5", { type: "file", mime: "text/plain", filename: "note.txt", url: "data:text/plain;base64,AAAA" }),
    ],
  });

  assert.deepEqual(evidence, []);
});
