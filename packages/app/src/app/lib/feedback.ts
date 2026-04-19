import html2canvas from "html2canvas";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

import { isTauriRuntime } from "../utils";
import { readDenAuth } from "./den-auth";
import { fetchJson } from "./http";

export const FEEDBACK_CAPTURE_SELECTOR = "[data-feedback-capture-root]";

const FEEDBACK_IMAGE_MIME_TYPE = "image/jpeg";
const FEEDBACK_IMAGE_QUALITY = 0.82;

type FetchLike = typeof globalThis.fetch;

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
  captureSurface?: () => Promise<FeedbackCaptureResult>;
  fetchImpl?: FetchLike;
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
};

const resolveFetch = (): FetchLike =>
  (isTauriRuntime() ? (tauriFetch as unknown as FetchLike) : globalThis.fetch);

const normalizeOptional = (value?: string | null) => {
  const trimmed = value?.trim() ?? "";
  return trimmed ? trimmed : null;
};

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
  const targetDocument = options.document ?? globalThis.document;
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
  };
}

export async function submitFeedbackReport(args: SubmitFeedbackReportArgs): Promise<void> {
  const auth = readDenAuth();
  if (!auth?.token || !auth.denApiBase) {
    throw new Error("Sign in to Den before sending feedback.");
  }

  let screenshot: FeedbackCaptureResult;
  try {
    screenshot = await (args.captureSurface ?? (() => captureFeedbackSurface()))();
  } catch {
    screenshot = {
      status: "failed",
      dataUrl: null,
      mimeType: null,
    };
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
  });

  const url = `${auth.denApiBase.replace(/\/+$/, "")}/v1/feedback`;
  try {
    await fetchJson<unknown>(url, {
      method: "POST",
      body: requestBody,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "x-veslo-org-id": auth.orgId,
      },
      fetchImpl: args.fetchImpl ?? resolveFetch(),
    });
  } catch (error) {
    throw normalizeFeedbackSubmitError(error, auth.denApiBase.replace(/\/+$/, ""));
  }
}
