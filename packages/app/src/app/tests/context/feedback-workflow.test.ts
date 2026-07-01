import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import { createFeedbackWorkflow } from "../../context/feedback-workflow.js";
import type { SubmitFeedbackReportResult } from "../../lib/feedback.js";

const okResult: SubmitFeedbackReportResult = {
  feedbackId: "fb_1",
  status: "projected",
  youtrackIssueId: "VSLO-123",
  youtrackIssueUrl: "https://youtrack.test/issue/VSLO-123",
};

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
      workflow.setSuccessIssueId("VSLO-OLD");
      workflow.openFeedbackModal();
      assert.equal(workflow.feedbackModalOpen(), true);
      assert.equal(workflow.feedbackSubmitError(), null);
      assert.equal(workflow.feedbackSubmitSuccessIssueId(), null);

      workflow.setSubmitError("closing error");
      workflow.setSuccessIssueId("VSLO-CLOSE");
      workflow.closeFeedbackModal();
      assert.equal(workflow.feedbackModalOpen(), false);
      assert.equal(workflow.feedbackSubmitError(), null);
      assert.equal(workflow.feedbackSubmitSuccessIssueId(), null);
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
        reportError: () => {},
        stringifyError: String,
      });

      await workflow.persistFeedback({ title: " Bug title ", description: " Details " });

      assert.deepEqual(submitted, [
        {
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
        },
      ]);
      assert.equal(workflow.feedbackSubmitSuccessIssueId(), "VSLO-123");
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
      assert.equal(workflow.feedbackSubmitSuccessIssueId(), "VSLO-123");
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
