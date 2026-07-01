export type DashboardUpdatePillCopy = {
  available: string;
  downloadFailed: string;
  downloading: string;
  downloadUpdate: string;
  installing: string;
  installUpdate: string;
  preparing: string;
  ready: string;
  retryDownload: string;
  retryingDownload: string;
  stopRunsToUpdate: string;
};

export type DashboardUpdateStatus = {
  state: string;
  downloadedBytes?: number;
  retry?: { kind: string } | null;
  totalBytes?: number | null;
  version?: string;
};

export type DashboardUpdatePillClickAction =
  | "download"
  | "install"
  | "open-settings"
  | "retry"
  | "none";

export type DashboardUpdatePillModel = {
  show: boolean;
  downloadPercent: number | null;
  label: string;
  actionLabel: string | null;
  actionDisabled: boolean;
  actionTitle: string;
  buttonTone: string;
  borderTone: string;
  dotTone: string;
  versionTone: string;
  title: string;
  clickAction: DashboardUpdatePillClickAction;
};

export type DashboardUpdatePillInput = {
  anyActiveRuns: boolean;
  copy: DashboardUpdatePillCopy;
  isDesktopRuntime: boolean;
  updateAutoDownload: boolean;
  updateStatus: DashboardUpdateStatus | null | undefined;
};

const visibleStates = new Set<string>([
  "available",
  "downloading",
  "installing",
  "ready",
]);

function isExhaustedDownloadError(status: DashboardUpdateStatus | null | undefined): boolean {
  return status?.state === "error" && status.retry?.kind === "exhausted";
}

export function resolveDashboardUpdateDownloadPercent(status: DashboardUpdateStatus | null | undefined): number | null {
  if (status?.state !== "downloading") return null;
  const total = status.totalBytes;
  if (total == null || total <= 0) return null;
  const downloaded = status.downloadedBytes ?? 0;
  const clamped = Math.max(0, Math.min(1, downloaded / total));
  return Math.floor(clamped * 100);
}

export function resolveDashboardUpdatePillClickAction(input: {
  anyActiveRuns: boolean;
  updateAutoDownload: boolean;
  updateStatus: DashboardUpdateStatus | null | undefined;
}): DashboardUpdatePillClickAction {
  const status = input.updateStatus;
  if (isExhaustedDownloadError(status)) return "retry";
  if (status?.state === "available" && !input.updateAutoDownload) return "download";
  if (status?.state === "available") return "none";
  if (status?.state === "ready" && !input.anyActiveRuns) return "install";
  if (status?.state === "ready" && input.anyActiveRuns) return "open-settings";
  if (status?.state === "downloading" || status?.state === "installing") return "open-settings";
  return "none";
}

function resolveLabel(input: DashboardUpdatePillInput, percent: number | null): string {
  const status = input.updateStatus;
  const copy = input.copy;
  if (status?.state === "ready") return copy.ready;
  if (status?.state === "installing") return copy.installing;
  if (status?.state === "available" && input.updateAutoDownload) return copy.preparing;
  if (isExhaustedDownloadError(status)) return copy.downloadFailed;
  if (status?.state === "downloading") {
    if (status.retry?.kind === "scheduled" || status.retry?.kind === "active") {
      return copy.retryingDownload;
    }
    return percent == null ? copy.downloading : `${copy.downloading} ${percent}%`;
  }
  return copy.available;
}

function resolveActionLabel(input: DashboardUpdatePillInput): string | null {
  const status = input.updateStatus;
  if (status?.state === "available" && !input.updateAutoDownload) return input.copy.downloadUpdate;
  if (status?.state === "ready") return input.copy.installUpdate;
  if (isExhaustedDownloadError(status)) return input.copy.retryDownload;
  return null;
}

function appendVersion(label: string, version: string | null): string {
  return version ? `${label} ${version}` : label;
}

export function resolveDashboardUpdatePillModel(input: DashboardUpdatePillInput): DashboardUpdatePillModel {
  const status = input.updateStatus;
  const state = status?.state;
  const retry = status?.state === "downloading" || status?.state === "error" ? status.retry : undefined;
  const show = Boolean(input.isDesktopRuntime && (
    (state && visibleStates.has(state)) ||
    isExhaustedDownloadError(status)
  ));
  const downloadPercent = resolveDashboardUpdateDownloadPercent(status);
  const label = resolveLabel(input, downloadPercent);
  const actionLabel = resolveActionLabel(input);
  const actionDisabled = status?.state === "ready" && input.anyActiveRuns;
  const version = status && "version" in status && status.version ? `v${status.version}` : "";
  const actionTitle = actionDisabled
    ? input.copy.stopRunsToUpdate
    : actionLabel
      ? appendVersion(actionLabel, version)
      : "";

  const readyWithActiveRuns = status?.state === "ready" && input.anyActiveRuns;
  const readyWithoutActiveRuns = status?.state === "ready" && !input.anyActiveRuns;
  const exhaustedError = isExhaustedDownloadError(status);
  const inProgress = status?.state === "downloading" || status?.state === "installing";

  const buttonTone = readyWithActiveRuns
    ? "text-amber-11 hover:text-amber-11 hover:bg-amber-3/30"
    : readyWithoutActiveRuns
      ? "text-green-11 hover:text-green-11 hover:bg-green-3/30"
      : exhaustedError
        ? "text-red-11 hover:text-red-11 hover:bg-red-3/30"
        : inProgress
          ? "text-blue-11 hover:text-blue-11 hover:bg-blue-3/30"
          : "text-dls-secondary hover:text-emerald-11 hover:bg-emerald-3/25";
  const borderTone = readyWithActiveRuns
    ? "border-amber-7/35"
    : readyWithoutActiveRuns
      ? "border-green-7/35"
      : exhaustedError
        ? "border-red-7/35"
        : inProgress
          ? "border-blue-7/35"
          : "border-dls-border";
  const dotTone = readyWithActiveRuns
    ? "text-amber-10 fill-amber-10"
    : readyWithoutActiveRuns
      ? "text-green-10 fill-green-10"
      : exhaustedError
        ? "text-red-10 fill-red-10"
        : inProgress
          ? "text-blue-10"
          : "text-emerald-10 fill-emerald-10";
  const versionTone = readyWithActiveRuns
    ? "text-amber-11/75"
    : readyWithoutActiveRuns
      ? "text-green-11/75"
      : exhaustedError
        ? "text-red-11/75"
        : inProgress
          ? "text-blue-11/75"
          : "text-dls-secondary";

  const titleVersion = version ? ` ${version}` : "";
  const title = readyWithActiveRuns
    ? `${input.copy.ready}${titleVersion}. ${input.copy.stopRunsToUpdate}.`
    : readyWithoutActiveRuns
      ? `${input.copy.ready}${titleVersion}`
      : exhaustedError
        ? `${input.copy.downloadFailed}${titleVersion}`
        : status?.state === "downloading" && (retry?.kind === "scheduled" || retry?.kind === "active")
          ? `${input.copy.retryingDownload}${titleVersion}`
          : status?.state === "downloading"
            ? `${input.copy.downloading}${titleVersion}`
            : status?.state === "installing"
              ? `${input.copy.installing}${titleVersion}`
              : status?.state === "available" && input.updateAutoDownload
                ? `${input.copy.preparing}${titleVersion}`
                : `${input.copy.available}${titleVersion}`;

  return {
    show,
    downloadPercent,
    label,
    actionLabel,
    actionDisabled,
    actionTitle,
    buttonTone,
    borderTone,
    dotTone,
    versionTone,
    title,
    clickAction: resolveDashboardUpdatePillClickAction(input),
  };
}
