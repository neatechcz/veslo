import html2canvas from "html2canvas";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { isTauriRuntime } from "../utils";
import { readDenAuth } from "./den-auth";
import { fetchJson } from "./http";
import { wrapStartupRequestAuditFetch } from "./startup-request-audit";
import {
  createFeedbackDiagnosticSnapshot,
  queueFeedbackDiagnosticSnapshotForDelivery,
  type UserDiagnosticCaptureStatus,
} from "./tauri";

export const FEEDBACK_CAPTURE_SELECTOR = "[data-feedback-capture-root]";

const FEEDBACK_IMAGE_MIME_TYPE = "image/jpeg";
const FEEDBACK_IMAGE_QUALITY = 0.82;
const FEEDBACK_SUBMIT_TIMEOUT_MS = 45_000;

type FetchLike = typeof globalThis.fetch;
const auditedTauriFetch = wrapStartupRequestAuditFetch(
  tauriFetch as unknown as FetchLike,
  "tauri.feedback",
);

export type FeedbackRuntimeContext = {
  view: string;
  pathname: string;
  tab: string;
  settingsTab: string;
  selectedSessionId: string | null;
  activeWorkspaceId: string | null;
  vesloServerWorkspaceId: string | null;
  activeWorkspaceType: string;
  activeWorkspaceRoot: string | null;
  locale: string;
  appVersion: string | null;
  platform: string | null;
};

export type FeedbackCaptureResult =
  | {
      status: "captured";
      dataUrl: string;
      mimeType: string;
    }
  | {
      status: "failed";
      dataUrl: null;
      mimeType: null;
    };

type Html2CanvasImpl = typeof html2canvas;

type FeedbackCaptureOptions = {
  document?: Pick<Document, "querySelector">;
  html2canvasImpl?: Html2CanvasImpl;
};

type SubmitFeedbackReportArgs = {
  title: string;
  description: string;
  context: FeedbackRuntimeContext;
  submissionId?: string;
  attachDiagnostics?: boolean;
  diagnosticCaptureId?: string;
  onDiagnosticSnapshotCreated?: (captureId: string) => void;
  screenshot?: FeedbackCaptureResult;
  onFeedbackRequestPrepared?: (screenshot: FeedbackCaptureResult) => void;
  captureSurface?: () => Promise<FeedbackCaptureResult>;
  fetchImpl?: FetchLike;
};

export type SubmitFeedbackReportResult = {
  feedbackId: string;
  status: "stored";
  diagnosticAttachment?: FeedbackDiagnosticAttachment;
};

export type FeedbackDiagnosticAttachment =
  | {
      status: "tracking";
      captureId: string;
      capture: UserDiagnosticCaptureStatus;
    }
  | {
      status: "unavailable";
    };

type FeedbackRequestBody = {
  title: string;
  description: string;
  userId: string;
  userEmail: string | null;
  orgId: string;
  orgName: string | null;
  context: FeedbackRuntimeContext;
  screenshotStatus: FeedbackCaptureResult["status"];
  screenshotDataUrl: string | null;
  screenshotMimeType: string | null;
  diagnosticCaptureId: string | null;
  submissionId: string;
};

type FeedbackSubmitResponse = {
  feedbackId?: unknown;
  status?: unknown;
};

type FeedbackDiagnosticCaptureLookupResponse = {
  linked?: unknown;
  feedbackId?: unknown;
};

const resolveFetch = (): FetchLike =>
  (isTauriRuntime() ? auditedTauriFetch : globalThis.fetch);

const normalizeOptional = (value?: string | null) => {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
};

const readResponseString = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

function normalizeFeedbackSubmitError(error: unknown, denApiBase: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/^HTTP 404\b/.test(message) && /Cannot POST \/v1\/feedback/.test(message)) {
    return new Error(
      `Feedback reporting is not enabled on this Den host yet. The configured Den API base (${denApiBase}) returned 404 for POST /v1/feedback.`,
    );
  }
  return error instanceof Error ? error : new Error(message);
}

export async function captureFeedbackSurface(
  options: FeedbackCaptureOptions = {},
): Promise<Extract<FeedbackCaptureResult, { status: "captured" }>> {
  const targetDocument: Pick<Document, "querySelector"> | undefined =
    options.document ?? (globalThis as { document?: Document }).document;
  if (!targetDocument) {
    throw new Error("Feedback screenshot capture is unavailable in this environment.");
  }

  const captureRoot = targetDocument.querySelector(FEEDBACK_CAPTURE_SELECTOR);
  if (!captureRoot) {
    throw new Error("Feedback screenshot root is unavailable on this screen.");
  }

  const canvas = await (options.html2canvasImpl ?? html2canvas)(captureRoot as HTMLElement, {
    backgroundColor: null,
    logging: false,
    scale: 1,
    useCORS: true,
  });

  return {
    status: "captured",
    dataUrl: canvas.toDataURL(FEEDBACK_IMAGE_MIME_TYPE, FEEDBACK_IMAGE_QUALITY),
    mimeType: FEEDBACK_IMAGE_MIME_TYPE,
  };
}

function buildFeedbackRequestBody(args: {
  title: string;
  description: string;
  context: FeedbackRuntimeContext;
  screenshot: FeedbackCaptureResult;
  userId: string;
  userEmail: string | null;
  orgId: string;
  orgName: string | null;
  diagnosticCaptureId: string | null;
  submissionId: string;
}): FeedbackRequestBody {
  return {
    title: args.title.trim(),
    description: args.description.trim(),
    userId: args.userId,
    userEmail: args.userEmail,
    orgId: args.orgId,
    orgName: args.orgName,
    context: args.context,
    screenshotStatus: args.screenshot.status,
    screenshotDataUrl: args.screenshot.dataUrl,
    screenshotMimeType: args.screenshot.mimeType,
    diagnosticCaptureId: args.diagnosticCaptureId,
    submissionId: args.submissionId,
  };
}

function normalizeFeedbackSubmitResult(response: FeedbackSubmitResponse): Omit<SubmitFeedbackReportResult, "diagnosticAttachment"> {
  const feedbackId = readResponseString(response.feedbackId);

  if (!feedbackId) {
    throw new Error("Feedback was saved, but Den did not return its record id.");
  }

  return {
    feedbackId,
    status: "stored",
  };
}

async function recoverFeedbackDiagnosticAttachment(args: {
  captureId: string;
  auth: NonNullable<ReturnType<typeof readDenAuth>>;
  fetchImpl: FetchLike;
}): Promise<Omit<SubmitFeedbackReportResult, "diagnosticAttachment"> | null> {
  try {
    const baseUrl = args.auth.denApiBase.replace(/\/+$/, "");
    const lookup = await fetchJson<FeedbackDiagnosticCaptureLookupResponse>(
      `${baseUrl}/v1/feedback/diagnostic-captures/${encodeURIComponent(args.captureId)}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${args.auth.token}`,
          "x-veslo-org-id": args.auth.orgId,
        },
        timeoutMs: FEEDBACK_SUBMIT_TIMEOUT_MS,
        fetchImpl: args.fetchImpl,
      },
    );
    if (lookup.linked !== true) return null;
    return normalizeFeedbackSubmitResult(lookup);
  } catch {
    return null;
  }
}

export async function submitFeedbackReport(args: SubmitFeedbackReportArgs): Promise<SubmitFeedbackReportResult> {
  const auth = readDenAuth();
  if (!auth?.token || !auth.denApiBase) {
    throw new Error("Sign in to Den before sending feedback.");
  }

  const diagnosticsRequested = args.attachDiagnostics === true;
  let diagnosticCaptureId = diagnosticsRequested ? args.diagnosticCaptureId?.trim() || null : null;
  if (diagnosticsRequested && !diagnosticCaptureId && isTauriRuntime()) {
    try {
      const capture = await createFeedbackDiagnosticSnapshot();
      const captureId = capture.captureId?.trim() || null;
      diagnosticCaptureId = captureId;
      if (captureId) args.onDiagnosticSnapshotCreated?.(captureId);
    } catch {
      // Feedback stays available even when local diagnostics cannot be attached.
    }
  }
  const submissionId = args.submissionId ?? diagnosticCaptureId ?? globalThis.crypto.randomUUID();

  let screenshot = args.screenshot;
  if (!screenshot) {
    try {
      screenshot = await (args.captureSurface ?? (() => captureFeedbackSurface()))();
    } catch {
      screenshot = {
        status: "failed",
        dataUrl: null,
        mimeType: null,
      };
    }
    args.onFeedbackRequestPrepared?.(screenshot);
  }

  const requestBody = buildFeedbackRequestBody({
    title: args.title,
    description: args.description,
    context: args.context,
    screenshot,
    userId: auth.user.id,
    userEmail: normalizeOptional(auth.user.email),
    orgId: auth.orgId,
    orgName: normalizeOptional(auth.org.name),
    diagnosticCaptureId,
    submissionId,
  });

  const url = `${auth.denApiBase.replace(/\/+$/, "")}/v1/feedback`;
  const fetchImpl = args.fetchImpl ?? resolveFetch();
  try {
    const result = await fetchJson<FeedbackSubmitResponse>(url, {
      method: "POST",
      body: requestBody,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "x-veslo-org-id": auth.orgId,
      },
      timeoutMs: FEEDBACK_SUBMIT_TIMEOUT_MS,
      fetchImpl,
    });
    const normalized = normalizeFeedbackSubmitResult(result);
    if (!diagnosticsRequested) {
      return normalized;
    }
    if (!diagnosticCaptureId) {
      return {
        ...normalized,
        diagnosticAttachment: { status: "unavailable" },
      };
    }
    try {
      const capture = await queueFeedbackDiagnosticSnapshotForDelivery(diagnosticCaptureId);
      if (capture.captureId !== diagnosticCaptureId) {
        return {
          ...normalized,
          diagnosticAttachment: { status: "unavailable" },
        };
      }
      return {
        ...normalized,
        diagnosticAttachment: {
          status: "tracking",
          captureId: diagnosticCaptureId,
          capture,
        },
      };
    } catch {
      return {
        ...normalized,
        diagnosticAttachment: { status: "unavailable" },
      };
    }
  } catch (error) {
    if (diagnosticCaptureId) {
      const recovered = await recoverFeedbackDiagnosticAttachment({
        captureId: diagnosticCaptureId,
        auth,
        fetchImpl,
      });
      if (recovered) {
        try {
          const capture = await queueFeedbackDiagnosticSnapshotForDelivery(diagnosticCaptureId);
          if (capture.captureId === diagnosticCaptureId) {
            return {
              ...recovered,
              diagnosticAttachment: { status: "tracking", captureId: diagnosticCaptureId, capture },
            };
          }
        } catch {
          return { ...recovered, diagnosticAttachment: { status: "unavailable" } };
        }
      }
    }
    throw normalizeFeedbackSubmitError(error, auth.denApiBase.replace(/\/+$/, ""));
  }
}
