import { createSignal, type Accessor } from "solid-js";

import {
  submitFeedbackReport,
  type FeedbackRuntimeContext,
  type SubmitFeedbackReportResult,
} from "../lib/feedback";

export type FeedbackFormValues = {
  title: string;
  description: string;
};

export type FeedbackRuntimeContextDeps = {
  view: () => string;
  pathname: () => string;
  tab: () => string;
  settingsTab: () => string;
  selectedSessionId: () => string | null | undefined;
  activeWorkspaceId: () => string | null | undefined;
  vesloServerWorkspaceId: () => string | null | undefined;
  activeWorkspaceType: () => string;
  activeWorkspaceRoot: () => string | null | undefined;
  selectedSessionDirectory: () => string | null | undefined;
  locale: () => string;
  appVersion: () => string | null | undefined;
  platform?: () => string | null | undefined;
  resolveSessionWorkspaceRoot: (sessionDirectory: string, workspaceRoot: string) => string;
};

export type FeedbackSubmitInput = {
  title: string;
  description: string;
  context: FeedbackRuntimeContext;
};

export type FeedbackWorkflowDeps = {
  runtimeContext?: FeedbackRuntimeContextDeps;
  buildContext?: () => FeedbackRuntimeContext;
  submitFeedbackReport?: (input: FeedbackSubmitInput) => Promise<SubmitFeedbackReportResult>;
  reportError: (error: unknown, scope: string) => void;
  stringifyError: (error: unknown) => string;
};

export type FeedbackWorkflow = {
  feedbackModalOpen: Accessor<boolean>;
  feedbackSubmitError: Accessor<string | null>;
  feedbackSubmitSuccessIssueId: Accessor<string | null>;
  feedbackSubmitting: Accessor<boolean>;
  setSubmitError: (error: string | null) => void;
  setSuccessIssueId: (issueId: string | null) => void;
  openFeedbackModal: () => void;
  closeFeedbackModal: () => void;
  persistFeedback: (values: FeedbackFormValues) => Promise<void>;
  submitFeedback: (values: FeedbackFormValues) => void;
};

function normalizeFeedbackOptional(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

function resolveFeedbackPlatform() {
  if (typeof navigator === "undefined") return null;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform;
  return normalizeFeedbackOptional(platform);
}

function requireRuntimeContext(deps: FeedbackWorkflowDeps): FeedbackRuntimeContextDeps {
  if (deps.runtimeContext) return deps.runtimeContext;
  throw new Error("Feedback workflow requires runtimeContext or buildContext.");
}

export function buildFeedbackRuntimeContext(deps: FeedbackRuntimeContextDeps): FeedbackRuntimeContext {
  const view = deps.view();
  const workspaceRoot = deps.activeWorkspaceRoot()?.trim() ?? "";
  const selectedSessionDirectory = deps.selectedSessionDirectory()?.trim() ?? "";
  const activeWorkspaceRoot =
    view === "session"
      ? deps.resolveSessionWorkspaceRoot(selectedSessionDirectory, workspaceRoot)
      : workspaceRoot;

  return {
    view,
    pathname: deps.pathname().trim() || "/",
    tab: deps.tab(),
    settingsTab: deps.settingsTab(),
    selectedSessionId: normalizeFeedbackOptional(deps.selectedSessionId()),
    activeWorkspaceId: normalizeFeedbackOptional(deps.activeWorkspaceId()),
    vesloServerWorkspaceId: normalizeFeedbackOptional(deps.vesloServerWorkspaceId()),
    activeWorkspaceType: deps.activeWorkspaceType(),
    activeWorkspaceRoot: normalizeFeedbackOptional(activeWorkspaceRoot),
    locale: deps.locale(),
    appVersion: normalizeFeedbackOptional(deps.appVersion()),
    platform: normalizeFeedbackOptional(deps.platform?.() ?? resolveFeedbackPlatform()),
  };
}

export function createFeedbackWorkflow(deps: FeedbackWorkflowDeps): FeedbackWorkflow {
  const [feedbackModalOpen, setFeedbackModalOpen] = createSignal(false);
  const [feedbackSubmitError, setFeedbackSubmitError] = createSignal<string | null>(null);
  const [feedbackSubmitSuccessIssueId, setFeedbackSubmitSuccessIssueId] = createSignal<string | null>(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = createSignal(false);
  const submitReport = deps.submitFeedbackReport ?? submitFeedbackReport;
  const buildContext = deps.buildContext ?? (() => buildFeedbackRuntimeContext(requireRuntimeContext(deps)));

  const clearFeedbackSubmitState = () => {
    setFeedbackSubmitError(null);
    setFeedbackSubmitSuccessIssueId(null);
  };

  const openFeedbackModal = () => {
    clearFeedbackSubmitState();
    setFeedbackModalOpen(true);
  };

  const closeFeedbackModal = () => {
    clearFeedbackSubmitState();
    setFeedbackModalOpen(false);
  };

  const persistFeedback = async (values: FeedbackFormValues) => {
    if (feedbackSubmitting()) return;

    clearFeedbackSubmitState();
    setFeedbackSubmitting(true);
    try {
      const result = await submitReport({
        title: values.title,
        description: values.description,
        context: buildContext(),
      });

      setFeedbackSubmitSuccessIssueId(result.youtrackIssueId);
    } finally {
      setFeedbackSubmitting(false);
    }
  };

  const submitFeedback = (values: FeedbackFormValues) => {
    void persistFeedback(values).catch((error) => {
      deps.reportError(error, "feedback.submit");
      setFeedbackSubmitError(error instanceof Error ? error.message : deps.stringifyError(error));
    });
  };

  return {
    feedbackModalOpen,
    feedbackSubmitError,
    feedbackSubmitSuccessIssueId,
    feedbackSubmitting,
    setSubmitError: setFeedbackSubmitError,
    setSuccessIssueId: setFeedbackSubmitSuccessIssueId,
    openFeedbackModal,
    closeFeedbackModal,
    persistFeedback,
    submitFeedback,
  };
}
