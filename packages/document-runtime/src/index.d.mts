export type DocumentRuntimeEnvironment = Record<string, string | undefined>;

export type DocumentRuntimeCheck = {
  id: string;
  ok: boolean;
  status?: string;
  path?: string;
  version?: string;
  error?: string;
};

export type DocumentRuntimeDoctorResult = {
  ok: boolean;
  status: string;
  packageId: string;
  packageVersion?: string;
  runtimeVersion?: string;
  platform?: string;
  runtimeRoot?: string;
  activePath?: string;
  repairAvailable?: boolean;
  checks: DocumentRuntimeCheck[];
};

export type DocumentRuntimeProviderOptions = {
  env?: DocumentRuntimeEnvironment;
  runtimeRoot?: string;
  activePath?: string;
  timeoutMs?: number;
};

export type DocumentRuntimeRepairResult = {
  ok: boolean;
  status: string;
  packageId: string;
  repaired?: boolean;
  reason?: string;
  activePath?: string;
  doctor?: DocumentRuntimeDoctorResult;
};

export type DocumentRuntimePackageInstallProgress = {
  phase: "feed" | "selected" | "downloading" | "cached" | "verifying" | "installing" | "ready" | "failed";
  artifactName?: string | null;
  downloadedBytes?: number | null;
  totalBytes?: number | null;
  percent?: number | null;
  message?: string | null;
};

export type DocumentRuntimePackageInstallOptions = DocumentRuntimeProviderOptions & {
  feed?: unknown;
  feedPath?: string;
  feedUrl?: string;
  platform?: string;
  channel?: string;
  appVersion?: string;
  currentVersion?: string;
  cacheDir?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: DocumentRuntimePackageInstallProgress) => void;
};

export function doctor(options?: DocumentRuntimeProviderOptions): Promise<DocumentRuntimeDoctorResult>;
export function repairHeadless(options?: DocumentRuntimeProviderOptions): Promise<DocumentRuntimeRepairResult>;
export function installPackageFromFeed(options?: DocumentRuntimePackageInstallOptions): Promise<DocumentRuntimeRepairResult>;
