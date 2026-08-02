import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import { createFeedbackWorkflow, type FeedbackSubmitInput } from "../../context/feedback-workflow.js";
import type { SubmitFeedbackReportResult } from "../../lib/feedback.js";
import type { UserDiagnosticCaptureStatus } from "../../lib/tauri.js";

const okResult: SubmitFeedbackReportResult = {
  feedbackId: "fb_1",
  status: "stored",
};

const queuedDiagnosticResult: SubmitFeedbackReportResult = {
  ...okResult,
  diagnosticAttachment: {
    status: "tracking",
    captureId: "capture-1",
    capture: {
      available: true,
      canStart: false,
      captureId: "capture-1",
      state: "queued",
      startedAt: 1,
      endsAt: 1,
      capturedEvents: 2,
      capturedBytes: 42,
      pendingEvents: 2,
      acceptedEvents: 0,
      droppedRetention: 0,
      droppedBudget: 0,
      droppedDelivery: 0,
      droppedIdentity: 0,
      terminalReason: null,
    },
  },
};

const queuedDiagnosticAttachment = queuedDiagnosticResult.diagnosticAttachment;
if (queuedDiagnosticAttachment?.status !== "tracking") {
  throw new Error("Queued diagnostic fixture must include a trackable attachment.");
}

test("feedback workflow opens and closes with cleared modal state", () => {
  createRoot((dispose) => {
    try {
      const workflow = createFeedbackWorkflow({
        buildContext: () => ({
          view: "dashboard",
          pathname: "/dashboard",
          tab: "scheduled",
          settingsTab: "general",
          selectedSessionId: null,
          activeWorkspaceId: null,
          vesloServerWorkspaceId: null,
          activeWorkspaceType: "local",
          activeWorkspaceRoot: null,
          locale: "en",
          appVersion: "2026.6.26",
          platform: "Windows",
        }),
        submitFeedbackReport: async () => okResult,
        reportError: () => {},
        stringifyError: String,
      });

      workflow.setSubmitError("stale error");
      workflow.setSuccessFeedbackId("fb-old");
      workflow.openFeedbackModal();
      assert.equal(workflow.feedbackModalOpen(), true);
      assert.equal(workflow.feedbackSubmitError(), null);
      assert.equal(workflow.feedbackSubmitSuccessFeedbackId(), null);

      workflow.setSubmitError("closing error");
      workflow.setSuccessFeedbackId("fb-close");
      workflow.closeFeedbackModal();
      assert.equal(workflow.feedbackModalOpen(), false);
      assert.equal(workflow.feedbackSubmitError(), null);
      assert.equal(workflow.feedbackSubmitSuccessFeedbackId(), null);
    } finally {
      dispose();
    }
  });
});

test("feedback workflow submits route, app, workspace, runtime, and platform context", async () => {
  await createRoot(async (dispose) => {
    try {
      const submitted: unknown[] = [];
      const workflow = createFeedbackWorkflow({
        runtimeContext: {
          view: () => "session",
          pathname: () => " /session/ses_1 ",
          tab: () => "plugins",
          settingsTab: () => "updates",
          selectedSessionId: () => " ses_1 ",
          activeWorkspaceId: () => " ws_1 ",
          vesloServerWorkspaceId: () => " veslo_ws_1 ",
          activeWorkspaceType: () => "remote",
          activeWorkspaceRoot: () => "/workspace",
          selectedSessionDirectory: () => "/workspace/packages/app",
          locale: () => "cs",
          appVersion: () => " 2026.6.26 ",
          platform: () => " Windows ",
          resolveSessionWorkspaceRoot: (sessionDirectory, workspaceRoot) => `${workspaceRoot}:${sessionDirectory}`,
        },
        submitFeedbackReport: async (input) => {
          submitted.push(input);
          return okResult;
        },
        createSubmissionId: () => "00000000-0000-4000-8000-000000000001",
        reportError: () => {},
        stringifyError: String,
      });

      await workflow.persistFeedback({ title: " Bug title ", description: " Details " });

      assert.equal(submitted.length, 1);
      const firstSubmission = submitted[0] as FeedbackSubmitInput;
      const {
        onDiagnosticSnapshotCreated,
        onFeedbackRequestPrepared,
        ...firstSubmissionPayload
      } = firstSubmission;
      assert.deepEqual(firstSubmissionPayload, {
          title: " Bug title ",
          description: " Details ",
          context: {
            view: "session",
            pathname: "/session/ses_1",
            tab: "plugins",
            settingsTab: "updates",
            selectedSessionId: "ses_1",
            activeWorkspaceId: "ws_1",
            vesloServerWorkspaceId: "veslo_ws_1",
            activeWorkspaceType: "remote",
            activeWorkspaceRoot: "/workspace:/workspace/packages/app",
            locale: "cs",
            appVersion: "2026.6.26",
            platform: "Windows",
          },
          submissionId: "00000000-0000-4000-8000-000000000001",
      });
      assert.equal(typeof onDiagnosticSnapshotCreated, "function");
      assert.equal(typeof onFeedbackRequestPrepared, "function");
      assert.equal(workflow.feedbackSubmitSuccessFeedbackId(), "fb_1");
      assert.equal(workflow.feedbackSubmitting(), false);
    } finally {
      dispose();
    }
  });
});

test("feedback workflow ignores duplicate submit while busy", async () => {
  await createRoot(async (dispose) => {
    try {
      let resolveFirst!: (value: SubmitFeedbackReportResult) => void;
      let submitCalls = 0;
      const workflow = createFeedbackWorkflow({
        buildContext: () => ({
          view: "dashboard",
          pathname: "/dashboard",
          tab: "scheduled",
          settingsTab: "general",
          selectedSessionId: null,
          activeWorkspaceId: "ws_1",
          vesloServerWorkspaceId: null,
          activeWorkspaceType: "local",
          activeWorkspaceRoot: "/repo",
          locale: "en",
          appVersion: "2026.6.26",
          platform: "Windows",
        }),
        submitFeedbackReport: async () => {
          submitCalls += 1;
          return new Promise<SubmitFeedbackReportResult>((resolve) => {
            resolveFirst = resolve;
          });
        },
        reportError: () => {},
        stringifyError: String,
      });

      const first = workflow.persistFeedback({ title: "one", description: "first" });
      assert.equal(workflow.feedbackSubmitting(), true);

      await workflow.persistFeedback({ title: "two", description: "second" });
      assert.equal(submitCalls, 1);
      assert.equal(workflow.feedbackSubmitting(), true);

      resolveFirst(okResult);
      await first;

      assert.equal(workflow.feedbackSubmitting(), false);
      assert.equal(workflow.feedbackSubmitSuccessFeedbackId(), "fb_1");
    } finally {
      dispose();
    }
  });
});

test("feedback workflow retains the submission key and snapshot identity for an unchanged retry after an unknown outcome", async () => {
  await createRoot(async (dispose) => {
    try {
      const submitted: FeedbackSubmitInput[] = [];
      let attempts = 0;
      const workflow = createFeedbackWorkflow({
        buildContext: () => ({
          view: "dashboard",
          pathname: "/dashboard",
          tab: "scheduled",
          settingsTab: "general",
          selectedSessionId: null,
          activeWorkspaceId: "ws_1",
          vesloServerWorkspaceId: null,
          activeWorkspaceType: "local",
          activeWorkspaceRoot: "/repo",
          locale: "en",
          appVersion: "2026.6.26",
          platform: "Windows",
        }),
        submitFeedbackReport: async (input) => {
          submitted.push(input);
          attempts += 1;
          if (attempts === 1) input.onDiagnosticSnapshotCreated?.("00000000-0000-4000-8000-000000000003");
          if (attempts === 1) input.onFeedbackRequestPrepared?.({
            status: "captured",
            dataUrl: "data:image/jpeg;base64,stable",
            mimeType: "image/jpeg",
          });
          if (attempts === 1) throw new Error("feedback outcome unknown");
          return okResult;
        },
        createSubmissionId: () => "00000000-0000-4000-8000-000000000002",
        reportError: () => {},
        stringifyError: String,
      });

      await assert.rejects(workflow.persistFeedback({ title: "Bug", description: "Details", attachDiagnostics: true }));
      await workflow.persistFeedback({ title: "Bug", description: "Details", attachDiagnostics: true });

      assert.equal(submitted.length, 2);
      assert.equal(submitted[0]?.submissionId, "00000000-0000-4000-8000-000000000002");
      assert.equal(submitted[1]?.submissionId, submitted[0]?.submissionId);
      assert.equal(submitted[1]?.diagnosticCaptureId, "00000000-0000-4000-8000-000000000003");
      assert.deepEqual(submitted[1]?.screenshot, {
        status: "captured",
        dataUrl: "data:image/jpeg;base64,stable",
        mimeType: "image/jpeg",
      });
    } finally {
      dispose();
    }
  });
});

test("feedback workflow keeps the modal open while a diagnostic attachment is still uploading", async () => {
  await createRoot(async (dispose) => {
    try {
      const workflow = createFeedbackWorkflow({
        buildContext: () => ({
          view: "dashboard",
          pathname: "/dashboard",
          tab: "scheduled",
          settingsTab: "general",
          selectedSessionId: null,
          activeWorkspaceId: "ws_1",
          vesloServerWorkspaceId: null,
          activeWorkspaceType: "local",
          activeWorkspaceRoot: "/repo",
          locale: "en",
          appVersion: "2026.6.26",
          platform: "Windows",
        }),
        submitFeedbackReport: async () => queuedDiagnosticResult,
        readDiagnosticCaptureStatus: async () => queuedDiagnosticAttachment.capture,
        reportError: () => {},
        stringifyError: String,
      });

      workflow.openFeedbackModal();
      await workflow.persistFeedback({ title: "Bug", description: "Details", attachDiagnostics: true });

      assert.deepEqual(workflow.feedbackDiagnosticAttachment(), queuedDiagnosticResult.diagnosticAttachment);
      assert.equal(workflow.feedbackDiagnosticUploadPending(), true);
      workflow.closeFeedbackModal();
      assert.equal(workflow.feedbackModalOpen(), true);
      assert.equal(workflow.feedbackDiagnosticAttachment()?.status, "tracking");
    } finally {
      dispose();
    }
  });
});

test("feedback workflow retains its blocking attachment state when a diagnostic status read fails", async () => {
  await createRoot(async (dispose) => {
    try {
      const workflow = createFeedbackWorkflow({
        buildContext: () => ({
          view: "dashboard",
          pathname: "/dashboard",
          tab: "scheduled",
          settingsTab: "general",
          selectedSessionId: null,
          activeWorkspaceId: "ws_1",
          vesloServerWorkspaceId: null,
          activeWorkspaceType: "local",
          activeWorkspaceRoot: "/repo",
          locale: "en",
          appVersion: "2026.6.26",
          platform: "Windows",
        }),
        submitFeedbackReport: async () => queuedDiagnosticResult,
        readDiagnosticCaptureStatus: async () => {
          throw new Error("native status unavailable");
        },
        diagnosticStatusPollMs: 60_000,
        reportError: () => {},
        stringifyError: String,
      });

      workflow.openFeedbackModal();
      await workflow.persistFeedback({ title: "Bug", description: "Details", attachDiagnostics: true });

      assert.equal(workflow.feedbackDiagnosticAttachment()?.status, "tracking");
      assert.equal(workflow.feedbackDiagnosticUploadPending(), true);
      workflow.closeFeedbackModal();
      assert.equal(workflow.feedbackModalOpen(), true);
    } finally {
      dispose();
    }
  });
});

test("feedback workflow ignores a stale diagnostic status result after its state is cleared", async () => {
  await createRoot(async (dispose) => {
    try {
      let resolveStatus!: (value: UserDiagnosticCaptureStatus) => void;
      const workflow = createFeedbackWorkflow({
        buildContext: () => ({
          view: "dashboard",
          pathname: "/dashboard",
          tab: "scheduled",
          settingsTab: "general",
          selectedSessionId: null,
          activeWorkspaceId: "ws_1",
          vesloServerWorkspaceId: null,
          activeWorkspaceType: "local",
          activeWorkspaceRoot: "/repo",
          locale: "en",
          appVersion: "2026.6.26",
          platform: "Windows",
        }),
        submitFeedbackReport: async () => queuedDiagnosticResult,
        readDiagnosticCaptureStatus: () => new Promise((resolve) => {
          resolveStatus = resolve;
        }),
        reportError: () => {},
        stringifyError: String,
      });

      workflow.openFeedbackModal();
      await workflow.persistFeedback({ title: "Bug", description: "Details", attachDiagnostics: true });
      workflow.openFeedbackModal();
      resolveStatus(queuedDiagnosticAttachment.capture);
      await Promise.resolve();

      assert.equal(workflow.feedbackDiagnosticAttachment(), null);
    } finally {
      dispose();
    }
  });
});

test("feedback workflow reports submit failures inside modal state", async () => {
  await createRoot(async (dispose) => {
    try {
      const reported: Array<{ message: string; scope: string }> = [];
      const workflow = createFeedbackWorkflow({
        buildContext: () => ({
          view: "dashboard",
          pathname: "/dashboard",
          tab: "scheduled",
          settingsTab: "general",
          selectedSessionId: null,
          activeWorkspaceId: "ws_1",
          vesloServerWorkspaceId: null,
          activeWorkspaceType: "local",
          activeWorkspaceRoot: "/repo",
          locale: "en",
          appVersion: "2026.6.26",
          platform: "Windows",
        }),
        submitFeedbackReport: async () => {
          throw new Error("submit failed");
        },
        reportError: (error, scope) => {
          reported.push({ message: error instanceof Error ? error.message : String(error), scope });
        },
        stringifyError: JSON.stringify,
      });

      workflow.submitFeedback({ title: "one", description: "body" });
      await Promise.resolve();
      await Promise.resolve();

      assert.deepEqual(reported, [{ message: "submit failed", scope: "feedback.submit" }]);
      assert.equal(workflow.feedbackSubmitError(), "submit failed");
      assert.equal(workflow.feedbackSubmitting(), false);
    } finally {
      dispose();
    }
  });
});
