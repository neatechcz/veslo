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
      part("p2f", {
        type: "tool",
        tool: "browser_screenshot",
        state: { status: "completed", images: ["https://example.com/icon.svg"] },
      }),
      part("p2g", {
        type: "tool",
        tool: "browser_screenshot",
        state: { status: "completed", images: [{ url: "https://example.com/icon.svg", alt: "Vector URL" }] },
      }),
      part("p2h", {
        type: "tool",
        tool: "browser_screenshot",
        state: { status: "completed", images: [{ src: "https://example.com/icon.svg", alt: "Vector src" }] },
      }),
      part("p2-spoof-inline", {
        type: "file",
        mime: "image/png",
        filename: "icon.svg",
        url: "https://example.com/icon.svg",
      }),
      part("p2-spoof-url", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [{ url: "https://example.com/icon.svg", mediaType: "image/png", alt: "Spoofed URL" }],
        },
      }),
      part("p2-spoof-src", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [{ src: "https://example.com/icon.svg", mediaType: "image/png", alt: "Spoofed src" }],
        },
      }),
      part("p2-spoof-filename", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [{ data: "AAAA", mediaType: "image/png", filename: "icon.svg" }],
        },
      }),
      part("p2-spoof-name", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [{ data: "BBBB", mediaType: "image/png", name: "icon.svg" }],
        },
      }),
      part("p2-spoof-encoded", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [{ url: "https://example.com/icon%2Esvg", mediaType: "image/png", alt: "Encoded spoof" }],
        },
      }),
    ],
  });

  assert.deepEqual(evidence, []);
});

test("infers structured bitmap url mime from extension", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p2i",
    defaultKind: "analyzed",
    parts: [
      part("p2i", {
        type: "tool",
        tool: "browser_screenshot",
        state: { status: "completed", images: ["https://example.com/preview.png"] },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.mime, "image/png");
  assert.equal(evidence[0]?.src, "https://example.com/preview.png");
});

test("infers structured bitmap url mime from encoded extension", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p2i-encoded",
    defaultKind: "analyzed",
    parts: [
      part("p2i-encoded", {
        type: "tool",
        tool: "browser_screenshot",
        state: { status: "completed", images: ["https://example.com/preview%2Epng"] },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.mime, "image/png");
  assert.equal(evidence[0]?.src, "https://example.com/preview%2Epng");
});

test("rejects unsafe inline and structured image source schemes", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p2j",
    defaultKind: "analyzed",
    parts: [
      part("p2j-inline", {
        type: "file",
        mime: "image/png",
        filename: "unsafe.png",
        url: "javascript:alert(1)",
      }),
      part("p2j-tool", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [
            { src: "javascript:alert(1)", mediaType: "image/png", alt: "Unsafe src" },
            { url: "ftp://example.com/image.png", mediaType: "image/png", alt: "Unsafe URL" },
          ],
        },
      }),
    ],
  });

  assert.deepEqual(evidence, []);
});

test("keeps allowed inline and structured image source schemes", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p2k",
    defaultKind: "analyzed",
    parts: [
      part("p2k-inline-data", {
        type: "file",
        mime: "image/png",
        filename: "inline.png",
        url: "data:image/png;base64,AAAA",
      }),
      part("p2k-inline-http", {
        type: "file",
        mime: "image/jpeg",
        filename: "remote.jpg",
        url: "https://example.com/remote.jpg",
      }),
      part("p2k-inline-blob", {
        type: "file",
        mime: "image/gif",
        filename: "blob.gif",
        url: "blob:https://example.com/blob-id",
      }),
      part("p2k-tool", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [
            "data:image/webp;base64,BBBB",
            { url: "http://example.com/preview.png", alt: "HTTP preview" },
            { src: "blob:https://example.com/blob-id", mediaType: "image/png", alt: "Blob preview" },
          ],
        },
      }),
    ],
  });

  assert.equal(evidence.length, 6);
  assert.equal(evidence.some((item) => item.src === "data:image/png;base64,AAAA"), true);
  assert.equal(evidence.some((item) => item.src === "https://example.com/remote.jpg"), true);
  assert.equal(evidence.some((item) => item.src === "blob:https://example.com/blob-id"), true);
  assert.equal(evidence.some((item) => item.src === "data:image/webp;base64,BBBB"), true);
  assert.equal(evidence.some((item) => item.src === "http://example.com/preview.png"), true);
});

test("keeps extensionless sources with bitmap metadata", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p2l",
    defaultKind: "analyzed",
    parts: [
      part("p2l-inline", {
        type: "file",
        mime: "image/png",
        filename: "preview",
        url: "https://example.com/render",
      }),
      part("p2l-tool", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [{ src: "blob:https://example.com/blob-id", mediaType: "image/png", alt: "Blob preview" }],
        },
      }),
    ],
  });

  assert.equal(evidence.length, 2);
  assert.equal(evidence.some((item) => item.src === "https://example.com/render"), true);
  assert.equal(evidence.some((item) => item.src === "blob:https://example.com/blob-id"), true);
});

test("normalizes accepted image mime values", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p2m",
    defaultKind: "analyzed",
    parts: [
      part("p2m-inline", {
        type: "file",
        mime: "Image/PNG; charset=binary",
        filename: "inline.png",
        url: "data:image/png;base64,AAAA",
      }),
      part("p2m-tool", {
        type: "tool",
        tool: "browser_screenshot",
        state: {
          status: "completed",
          images: [{ data: "BBBB", mediaType: "Image/PNG; charset=binary", alt: "Normalized preview" }],
        },
      }),
    ],
  });

  assert.equal(evidence.length, 2);
  assert.equal(evidence[0]?.mime, "image/png");
  assert.equal(evidence[1]?.mime, "image/png");
  assert.equal(evidence[1]?.src, "data:image/png;base64,BBBB");
});

test("does not create workspace file evidence for relative parent traversal paths", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3-traversal",
    workspaceRoot: "/Users/me/project",
    parts: [
      part("p3-traversal", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "../private.png" } },
      }),
    ],
  });

  assert.deepEqual(evidence, []);
});

test("does not create file evidence for absolute parent traversal paths", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3-absolute-traversal",
    workspaceRoot: "/Users/me/project",
    parts: [
      part("p3-absolute-traversal", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "/Users/me/project/../private.png" } },
      }),
    ],
  });

  assert.deepEqual(evidence, []);
});

test("does not create file evidence for absolute paths outside workspace root", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3-outside-root",
    workspaceRoot: "/Users/me/project",
    parts: [
      part("p3-outside-root", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "/Users/me/other/result.png" } },
      }),
    ],
  });

  assert.deepEqual(evidence, []);
});

test("keeps absolute file evidence inside workspace root", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3-inside-root",
    workspaceRoot: "/Users/me/project",
    parts: [
      part("p3-inside-root", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "/Users/me/project/screens/result.png" } },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.src, "file:///Users/me/project/screens/result.png");
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

test("encodes reserved filename characters in workspace file urls", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3c-reserved",
    workspaceRoot: "/Users/me/project",
    parts: [
      part("p3c-reserved", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "screens/result #1?.png" } },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.src, "file:///Users/me/project/screens/result%20%231%3F.png");
});

test("formats windows absolute file urls", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3d",
    workspaceRoot: "C:/Users/me/project",
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

test("keeps rootless absolute created paths missing without file urls", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:p3d-rootless",
    parts: [
      part("p3d-rootless", {
        type: "tool",
        tool: "write",
        state: { status: "completed", input: { filePath: "/Users/me/project/result.png" } },
      }),
    ],
  });

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.path, "/Users/me/project/result.png");
  assert.equal(evidence[0]?.src, undefined);
  assert.equal(evidence[0]?.status, "missing");
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

test("does not extract structured images from unsuccessful tool states", () => {
  for (const status of ["error", "failed", "running", "pending"]) {
    const evidence = buildMediaEvidenceForParts({
      sourceId: `tool:structured:${status}`,
      defaultKind: "analyzed",
      parts: [
        part(`p-structured-${status}`, {
          type: "tool",
          tool: "browser_screenshot",
          state: {
            status,
            images: [{ data: "BBBB", mediaType: "image/png", alt: "Incomplete screenshot" }],
          },
        }),
      ],
    });

    assert.deepEqual(evidence, []);
  }
});

test("keeps structured ids unique when duplicate part ids appear across parts", () => {
  const evidence = buildMediaEvidenceForParts({
    sourceId: "tool:duplicate-structured",
    defaultKind: "analyzed",
    parts: [
      part("p-duplicate", {
        type: "tool",
        tool: "browser_screenshot",
        state: { status: "completed", images: [{ data: "AAAA", mediaType: "image/png", alt: "First" }] },
      }),
      part("p-duplicate", {
        type: "tool",
        tool: "browser_screenshot",
        state: { status: "completed", images: [{ data: "BBBB", mediaType: "image/png", alt: "Second" }] },
      }),
    ],
  });

  assert.equal(evidence.length, 2);
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
