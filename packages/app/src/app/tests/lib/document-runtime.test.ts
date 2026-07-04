import assert from "node:assert/strict";
import test from "node:test";

import {
  documentRuntimeSettingsRow,
  documentRuntimeSkillReady,
  documentRuntimeTaskBlockReason,
  type DocumentRuntimeStatus,
  type DocumentRuntimeStatusPayload,
} from "../../lib/document-runtime.js";

function payload(status: DocumentRuntimeStatus, overrides: Partial<DocumentRuntimeStatusPayload> = {}): DocumentRuntimeStatusPayload {
  const ready = status === "ready";
  return {
    runtimeId: "veslo-document-runtime",
    status,
    ready,
    updatedAt: "2026-07-02T12:00:00.000Z",
    source: "server",
    skills: [
      { id: "veslo-docx", format: "docx", ready, reason: status },
      { id: "veslo-xlsx", format: "xlsx", ready, reason: status },
      { id: "veslo-pdf", format: "pdf", ready, reason: status },
      { id: "veslo-pptx", format: "pptx", ready, reason: status },
    ],
    package: {
      installedVersion: null,
      activePackage: null,
      updateAvailable: status === "package_update_available",
      installing: status === "package_installing",
      rollback: status === "package_rollback",
      remoteOnly: status === "remote_only",
    },
    repair: {
      available: false,
      inProgress: status === "repairing",
      blockedReason: null,
      lastAttemptAt: null,
      lastError: null,
    },
    policy: {
      windowsWslRuntime: "not_applicable",
    },
    ...overrides,
  };
}

test("document runtime skill readiness follows per-format skill state", () => {
  const status = payload("ready", {
    skills: [
      { id: "veslo-docx", format: "docx", ready: true, reason: "ready" },
      { id: "veslo-xlsx", format: "xlsx", ready: false, reason: "failed" },
      { id: "veslo-pdf", format: "pdf", ready: true, reason: "ready" },
      { id: "veslo-pptx", format: "pptx", ready: true, reason: "ready" },
    ],
  });

  assert.equal(documentRuntimeSkillReady(status, "docx"), true);
  assert.equal(documentRuntimeSkillReady(status, "xlsx"), false);
  assert.equal(documentRuntimeTaskBlockReason(status, "docx"), null);
  assert.match(documentRuntimeTaskBlockReason(status, "xlsx") ?? "", /not ready for this file type/);
});

test("missing runtime blocks local document tasks and offers repair when available", () => {
  const status = payload("missing", {
    repair: {
      available: true,
      inProgress: false,
      blockedReason: null,
      lastAttemptAt: null,
      lastError: null,
    },
  });

  assert.match(documentRuntimeTaskBlockReason(status, "docx") ?? "", /package is missing/);
  assert.deepEqual(documentRuntimeSettingsRow(status), {
    status: "missing",
    tone: "danger",
    title: "Document runtime",
    detail: "Runtime package is not available.",
    action: "repair",
  });
});

test("remote-only mode stays distinct from ready local runtime", () => {
  const status = payload("remote_only");

  assert.equal(documentRuntimeSkillReady(status, "pdf"), false);
  assert.match(documentRuntimeTaskBlockReason(status, "pdf") ?? "", /remote document-capable worker/);
  assert.equal(documentRuntimeSettingsRow(status).action, "none");
  assert.equal(documentRuntimeSettingsRow(status).tone, "warning");
});

test("maintenance and update states map to wait or update actions", () => {
  assert.equal(documentRuntimeSettingsRow(payload("repairing")).action, "wait");
  assert.equal(documentRuntimeSettingsRow(payload("package_installing")).action, "wait");
  assert.equal(documentRuntimeSettingsRow(payload("package_rollback")).action, "wait");
  assert.equal(documentRuntimeSettingsRow(payload("outdated")).action, "update");
  assert.equal(documentRuntimeSettingsRow(payload("package_update_available")).action, "update");
});
