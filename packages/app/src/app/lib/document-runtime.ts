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

export type DocumentRuntimeStatusPayload = {
  runtimeId: typeof DOCUMENT_RUNTIME_ID;
  status: DocumentRuntimeStatus;
  ready: boolean;
  updatedAt: string;
  source: "server" | "desktop" | "updater";
  skills: DocumentRuntimeSkillReadiness[];
  package: {
    installedVersion: string | null;
    activePackage: string | null;
    updateAvailable: boolean;
    installing: boolean;
    rollback: boolean;
    remoteOnly: boolean;
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
  action: "none" | "repair" | "update" | "wait";
};

const documentRuntimeSkillFormats: Record<DocumentRuntimeFormat, DocumentRuntimeSkillId> = {
  docx: "veslo-docx",
  xlsx: "veslo-xlsx",
  pdf: "veslo-pdf",
  pptx: "veslo-pptx",
};

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
      return "Document runtime package is missing. Repair or update Veslo before starting this document task.";
    case "repairing":
    case "package_installing":
      return "Document runtime repair is still in progress. Wait until it finishes before starting this document task.";
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
      return status.repair.blockedReason ?? "Document runtime repair is blocked.";
    case "failed":
      return status.repair.lastError ?? "Document runtime failed its readiness check.";
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
      };
    case "repairing":
    case "package_installing":
    case "package_rollback":
      return {
        status: status.status,
        tone: "info",
        title: "Document runtime",
        detail: "Runtime maintenance is in progress.",
        action: "wait",
      };
    case "outdated":
    case "package_update_available":
      return {
        status: status.status,
        tone: "warning",
        title: "Document runtime",
        detail: "A runtime package update is required.",
        action: "update",
      };
    case "missing":
    case "failed":
      return {
        status: status.status,
        tone: "danger",
        title: "Document runtime",
        detail: status.repair.lastError ?? "Runtime package is not available.",
        action: status.repair.available ? "repair" : "none",
      };
    case "remote_only":
      return {
        status: status.status,
        tone: "warning",
        title: "Document runtime",
        detail: "Local document runtime is disabled; document work must use a remote-capable worker.",
        action: "none",
      };
    case "blocked":
    case "disabled_by_product_policy":
      return {
        status: status.status,
        tone: "warning",
        title: "Document runtime",
        detail: status.repair.blockedReason ?? "Runtime is blocked by policy.",
        action: "none",
      };
  }
}
