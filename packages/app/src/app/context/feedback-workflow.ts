import { createSignal, onCleanup, type Accessor } from "solid-js";

import {
  submitFeedbackReport,
  type FeedbackDiagnosticAttachment,
  type FeedbackRuntimeContext,
  type SubmitFeedbackReportResult,
} from "../lib/feedback";
import { userDiagnosticCaptureStatus, type UserDiagnosticCaptureStatus } from "../lib/tauri";

export type FeedbackFormValues = {
  title: string;
  description: string;
  attachDiagnostics?: boolean;
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
  attachDiagnostics?: boolean;
  context: FeedbackRuntimeContext;
};

export type FeedbackWorkflowDeps = {
  runtimeContext?: FeedbackRuntimeContextDeps;
  buildContext?: () => FeedbackRuntimeContext;
  submitFeedbackReport?: (input: FeedbackSubmitInput) => Promise<SubmitFeedbackReportResult>;
  reportError: (error: unknown, scope: string) => void;
  stringifyError: (error: unknown) => string;
  readDiagnosticCaptureStatus?: () => Promise<UserDiagnosticCaptureStatus>;
};

export type FeedbackWorkflow = {
  feedbackModalOpen: Accessor<boolean>;
  feedbackSubmitError: Accessor<string | null>;
  feedbackSubmitSuccessFeedbackId: Accessor<string | null>;
  feedbackSubmitting: Accessor<boolean>;
  feedbackDiagnosticAttachment: Accessor<FeedbackDiagnosticAttachment | null>;
  feedbackDiagnosticUploadPending: Accessor<boolean>;
  setSubmitError: (error: string | null) => void;
  setSuccessFeedbackId: (feedbackId: string | null) => void;
  openFeedbackModal: () => void;
  closeFeedbackModal: () => void;
  persistFeedback: (values: FeedbackFormValues) => Promise<void>;
  submitFeedback: (values: FeedbackFormValues) => void;
};

function normalizeFeedbackOptional(value?: string | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
}

const DIAGNOSTIC_STATUS_POLL_MS = 1_000;

function isTerminalDiagnosticState(state: string) {
  return [
    "uploaded",
    "uploaded_with_truncation",
    "delivery_rejected",
    "expired",
    "identity_changed",
    "undeliverable",
  ].includes(state);
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
  const [feedbackSubmitSuccessFeedbackId, setFeedbackSubmitSuccessFeedbackId] = createSignal<string | null>(null);
  const [feedbackSubmitting, setFeedbackSubmitting] = createSignal(false);
  const [feedbackDiagnosticAttachment, setFeedbackDiagnosticAttachment] = createSignal<FeedbackDiagnosticAttachment | null>(null);
  const submitReport = deps.submitFeedbackReport ?? submitFeedbackReport;
  const buildContext = deps.buildContext ?? (() => buildFeedbackRuntimeContext(requireRuntimeContext(deps)));
  const readDiagnosticCaptureStatus = deps.readDiagnosticCaptureStatus ?? userDiagnosticCaptureStatus;
  let diagnosticStatusPoll: ReturnType<typeof setTimeout> | undefined;

  const feedbackDiagnosticUploadPending = () => {
    const attachment = feedbackDiagnosticAttachment();
    return attachment?.status === "tracking" && !isTerminalDiagnosticState(attachment.capture.state);
  };

  const stopDiagnosticStatusPoll = () => {
    if (diagnosticStatusPoll !== undefined) {
      clearTimeout(diagnosticStatusPoll);
      diagnosticStatusPoll = undefined;
    }
  };

  const trackDiagnosticAttachment = (attachment: FeedbackDiagnosticAttachment | undefined) => {
    stopDiagnosticStatusPoll();
    setFeedbackDiagnosticAttachment(attachment ?? null);
    if (attachment?.status !== "tracking" || isTerminalDiagnosticState(attachment.capture.state)) return;

    const poll = async () => {
      try {
        const capture = await readDiagnosticCaptureStatus();
        if (capture.captureId !== attachment.captureId) {
          setFeedbackDiagnosticAttachment({ status: "unavailable" });
          return;
        }
        setFeedbackDiagnosticAttachment({
          status: "tracking",
          captureId: attachment.captureId,
          capture,
        });
        if (isTerminalDiagnosticState(capture.state)) return;
      } catch {
        // Keep the warning visible and retry. A transient status read must not
        // make a still-pending attachment look completed.
      }
      diagnosticStatusPoll = setTimeout(() => void poll(), DIAGNOSTIC_STATUS_POLL_MS);
    };

    void poll();
  };

  const clearFeedbackSubmitState = () => {
    stopDiagnosticStatusPoll();
    setFeedbackSubmitError(null);
    setFeedbackSubmitSuccessFeedbackId(null);
    setFeedbackDiagnosticAttachment(null);
  };

  const openFeedbackModal = () => {
    clearFeedbackSubmitState();
    setFeedbackModalOpen(true);
  };

  const closeFeedbackModal = () => {
    if (feedbackDiagnosticUploadPending()) return;
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
        ...(values.attachDiagnostics === undefined
          ? {}
          : { attachDiagnostics: values.attachDiagnostics }),
        context: buildContext(),
      });

      setFeedbackSubmitSuccessFeedbackId(result.feedbackId);
      trackDiagnosticAttachment(result.diagnosticAttachment);
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

  onCleanup(stopDiagnosticStatusPoll);

  return {
    feedbackModalOpen,
    feedbackSubmitError,
    feedbackSubmitSuccessFeedbackId,
    feedbackSubmitting,
    feedbackDiagnosticAttachment,
    feedbackDiagnosticUploadPending,
    setSubmitError: setFeedbackSubmitError,
    setSuccessFeedbackId: setFeedbackSubmitSuccessFeedbackId,
    openFeedbackModal,
    closeFeedbackModal,
    persistFeedback,
    submitFeedback,
  };
}
