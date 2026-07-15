import { sanitizeBootstrapDiagnosticPayload } from "./bootstrap-diagnostics";

const DOCUMENT_RUNTIME_ID = "veslo-document-runtime" as const;

const documentRuntimeStatuses = [
  "ready",
  "missing",
  "repairing",
  "blocked",
  "outdated",
  "failed",
  "disabled_by_product_policy",
  "package_update_available",
  "package_installing",
  "package_rollback",
  "remote_only",
] as const;

export type DocumentRuntimeStatus = typeof documentRuntimeStatuses[number];

type DocumentRuntimeSkillId = "veslo-docx" | "veslo-xlsx" | "veslo-pdf" | "veslo-pptx";

export type DocumentRuntimeFormat = "docx" | "xlsx" | "pdf" | "pptx";

type DocumentRuntimeSkillReadiness = {
  id: DocumentRuntimeSkillId;
  format: DocumentRuntimeFormat;
  ready: boolean;
  reason: DocumentRuntimeStatus;
};

type DocumentRuntimePackageInstallProgress = {
  phase: "feed" | "selected" | "downloading" | "cached" | "verifying" | "installing" | "ready" | "failed";
  artifactName: string | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  percent: number | null;
  message: string | null;
};

export type DocumentRuntimeStatusPayload = {
  runtimeId: typeof DOCUMENT_RUNTIME_ID;
  status: DocumentRuntimeStatus;
  ready: boolean;
  updatedAt: string;
  source: "server" | "desktop" | "updater";
  providerMode?: "bundled" | "module_override";
  skills: DocumentRuntimeSkillReadiness[];
  package: {
    installedVersion: string | null;
    activePackage: string | null;
    updateAvailable: boolean;
    installing: boolean;
    rollback: boolean;
    remoteOnly: boolean;
    progress: DocumentRuntimePackageInstallProgress | null;
  };
  repair: {
    available: boolean;
    inProgress: boolean;
    blockedReason: string | null;
    lastAttemptAt: string | null;
    lastError: string | null;
  };
  policy: {
    windowsWslRuntime: "disabled_by_product_policy" | "not_applicable";
  };
};

export type DocumentRuntimeSettingsRowModel = {
  status: DocumentRuntimeStatus;
  tone: "ready" | "info" | "warning" | "danger";
  title: string;
  detail: string;
  action: "none" | "install" | "repair" | "update" | "wait";
  progressPercent: number | null;
};

const documentRuntimeSkillFormats: Record<DocumentRuntimeFormat, DocumentRuntimeSkillId> = {
  docx: "veslo-docx",
  xlsx: "veslo-xlsx",
  pdf: "veslo-pdf",
  pptx: "veslo-pptx",
};

function firstNonEmptyDocumentRuntimeDetail(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function redactDocumentRuntimeDetail(value: string | null | undefined, fallback: string): string {
  return sanitizeBootstrapDiagnosticPayload(value?.trim() || fallback);
}

function documentRuntimeBlockedDetail(status: DocumentRuntimeStatusPayload, fallback: string): string {
  const detail = status.repair.blockedReason === "document_runtime_provider_unavailable"
    ? firstNonEmptyDocumentRuntimeDetail(status.repair.lastError, status.repair.blockedReason)
    : firstNonEmptyDocumentRuntimeDetail(status.repair.blockedReason, status.repair.lastError);
  return redactDocumentRuntimeDetail(detail, fallback);
}

export function redactDocumentRuntimeStatus(
  status: DocumentRuntimeStatusPayload | null | undefined,
): DocumentRuntimeStatusPayload | null {
  return status ? sanitizeBootstrapDiagnosticPayload(status) : null;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function documentRuntimeProgressDetail(progress: DocumentRuntimePackageInstallProgress | null | undefined): string | null {
  if (!progress) return null;
  if (progress.phase === "downloading") {
    const percent = typeof progress.percent === "number" ? `${progress.percent}%` : null;
    if (typeof progress.downloadedBytes === "number" && typeof progress.totalBytes === "number") {
      return `Downloading office package ${percent ?? ""} (${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes)}).`.replace("  ", " ");
    }
    return percent ? `Downloading office package ${percent}.` : "Downloading office package.";
  }
  if (progress.phase === "cached") return "Using cached office package.";
  if (progress.phase === "verifying") return "Verifying office package.";
  if (progress.phase === "installing") return "Installing office package.";
  if (progress.phase === "selected") return redactDocumentRuntimeDetail(progress.message, "Office package selected.");
  if (progress.phase === "feed") return "Loading office package feed.";
  if (progress.phase === "failed") return redactDocumentRuntimeDetail(progress.message, "Office package install failed.");
  if (progress.phase === "ready") return "Office package is ready.";
  return progress.message ? redactDocumentRuntimeDetail(progress.message, "") : null;
}

export function documentRuntimeSkillReady(
  status: DocumentRuntimeStatusPayload | null | undefined,
  format: DocumentRuntimeFormat,
): boolean {
  if (!status?.ready) return false;
  const skillId = documentRuntimeSkillFormats[format];
  return status.skills.some((skill) => skill.id === skillId && skill.ready);
}

export function documentRuntimeTaskBlockReason(
  status: DocumentRuntimeStatusPayload | null | undefined,
  format: DocumentRuntimeFormat,
): string | null {
  if (documentRuntimeSkillReady(status, format)) return null;
  if (!status) return "Document runtime status is not loaded yet.";

  switch (status.status) {
    case "missing":
      return "Office document package is missing. Install it before starting this document task.";
    case "repairing":
    case "package_installing":
      return "Office document package installation is still in progress. Wait until it finishes before starting this document task.";
    case "outdated":
    case "package_update_available":
      return "Document runtime package must be updated before starting this document task.";
    case "package_rollback":
      return "Document runtime package is rolling back. Wait until recovery finishes before starting this document task.";
    case "remote_only":
      return "Local document runtime is disabled for this install. Use a remote document-capable worker instead.";
    case "disabled_by_product_policy":
      return "Document runtime is disabled by product policy for this install.";
    case "blocked":
      return documentRuntimeBlockedDetail(status, "Document runtime repair is blocked.");
    case "failed":
      return redactDocumentRuntimeDetail(status.repair.lastError, "Document runtime failed its readiness check.");
    case "ready":
      return "Document runtime is not ready for this file type.";
  }
}

export function documentRuntimeSettingsRow(status: DocumentRuntimeStatusPayload | null | undefined): DocumentRuntimeSettingsRowModel {
  if (!status) {
    return {
      status: "missing",
      tone: "warning",
      title: "Document runtime",
      detail: "Status has not been loaded yet.",
      action: "wait",
      progressPercent: null,
    };
  }

  switch (status.status) {
    case "ready":
      return {
        status: status.status,
        tone: "ready",
        title: "Document runtime",
        detail: status.package.installedVersion
          ? `Ready (${status.package.installedVersion}).`
          : "Ready.",
        action: "none",
        progressPercent: null,
      };
    case "repairing":
    case "package_installing":
    case "package_rollback":
      return {
        status: status.status,
        tone: "info",
        title: "Document runtime",
        detail: documentRuntimeProgressDetail(status.package.progress) ?? "Runtime maintenance is in progress.",
        action: "wait",
        progressPercent: status.package.progress?.percent ?? null,
      };
    case "outdated":
    case "package_update_available":
      return {
        status: status.status,
        tone: "warning",
        title: "Document runtime",
        detail: "A runtime package update is required.",
        action: "update",
        progressPercent: null,
      };
    case "missing":
      return {
        status: status.status,
        tone: "danger",
        title: "Document runtime",
        detail: redactDocumentRuntimeDetail(status.repair.lastError, "Office document package is not installed."),
        action: status.repair.available ? "install" : "none",
        progressPercent: null,
      };
    case "failed":
      return {
        status: status.status,
        tone: "danger",
        title: "Document runtime",
        detail: redactDocumentRuntimeDetail(status.repair.lastError, "Runtime package is not available."),
        action: status.repair.available ? "repair" : "none",
        progressPercent: null,
      };
    case "remote_only":
      return {
        status: status.status,
        tone: "warning",
        title: "Document runtime",
        detail: "Local document runtime is disabled; document work must use a remote-capable worker.",
        action: "none",
        progressPercent: null,
      };
    case "blocked":
    case "disabled_by_product_policy":
      return {
        status: status.status,
        tone: "warning",
        title: "Document runtime",
        detail: documentRuntimeBlockedDetail(status, "Runtime is blocked by policy."),
        action: "none",
        progressPercent: null,
      };
  }
}
