import { jsonResponse } from "../route-helpers.js";
import { addRoute, type RequestContext, type Route } from "../routing.js";

export const DOCUMENT_RUNTIME_ID = "veslo-document-runtime";

export const DOCUMENT_RUNTIME_STATUS_VALUES = [
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

export type DocumentRuntimeStatus = typeof DOCUMENT_RUNTIME_STATUS_VALUES[number];

export type DocumentRuntimeSkillReadiness = {
  id: "veslo-docx" | "veslo-xlsx" | "veslo-pdf" | "veslo-pptx";
  format: "docx" | "xlsx" | "pdf" | "pptx";
  ready: boolean;
  reason: DocumentRuntimeStatus;
};

export type DocumentRuntimePackageInstallProgress = {
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

export type DocumentRuntimeRouteDependencies = {
  readStatus?: (ctx: RequestContext) => Promise<DocumentRuntimeStatusPayload> | DocumentRuntimeStatusPayload;
  repair?: (ctx: RequestContext) => Promise<DocumentRuntimeStatusPayload> | DocumentRuntimeStatusPayload;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

export type DocumentRuntimeDoctorResult = {
  ok?: boolean;
  status?: string | null;
  packageVersion?: string | null;
  activePath?: string | null;
  repairAvailable?: boolean;
  checks?: Array<{ ok?: boolean; error?: string | null }>;
};

export type DocumentRuntimeRepairResult = {
  ok?: boolean;
  status?: string | null;
  repaired?: boolean;
  reason?: string | null;
  doctor?: DocumentRuntimeDoctorResult | null;
};

export type DocumentRuntimeProvider = {
  doctor: (options?: { env?: NodeJS.ProcessEnv }) => Promise<DocumentRuntimeDoctorResult> | DocumentRuntimeDoctorResult;
  repairHeadless: (options?: { env?: NodeJS.ProcessEnv }) => Promise<DocumentRuntimeRepairResult> | DocumentRuntimeRepairResult;
  installPackageFromFeed?: (options?: {
    env?: NodeJS.ProcessEnv;
    onProgress?: (progress: DocumentRuntimePackageInstallProgress) => void;
  }) => Promise<DocumentRuntimeRepairResult> | DocumentRuntimeRepairResult;
};

const DOCUMENT_RUNTIME_SKILLS: Array<Omit<DocumentRuntimeSkillReadiness, "ready" | "reason">> = [
  { id: "veslo-docx", format: "docx" },
  { id: "veslo-xlsx", format: "xlsx" },
  { id: "veslo-pdf", format: "pdf" },
  { id: "veslo-pptx", format: "pptx" },
];

function isRemoteOnlyMode(env: NodeJS.ProcessEnv): boolean {
  const mode = (env.VESLO_DOCUMENT_RUNTIME_MODE ?? env.VESLO_DOCUMENT_RUNTIME_INSTALL_MODE ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
  return mode === "remote-only" || mode === "remote-docs-only";
}

function normalizeDocumentRuntimeStatus(value: string | null | undefined): DocumentRuntimeStatus {
  return DOCUMENT_RUNTIME_STATUS_VALUES.includes(value as DocumentRuntimeStatus)
    ? value as DocumentRuntimeStatus
    : "failed";
}

function firstDoctorError(result: DocumentRuntimeDoctorResult | null | undefined): string | null {
  const failed = result?.checks?.find((check) => check && check.ok === false && check.error);
  return failed?.error?.trim() || null;
}

export function createDocumentRuntimeStatusPayload(
  options: Partial<DocumentRuntimeRouteDependencies> & {
    status?: DocumentRuntimeStatus;
    installedVersion?: string | null;
    activePackage?: string | null;
    packageProgress?: DocumentRuntimePackageInstallProgress | null;
    repairBlockedReason?: string | null;
    repairLastError?: string | null;
  } = {},
): DocumentRuntimeStatusPayload {
  const env = options.env ?? process.env;
  const remoteOnly = isRemoteOnlyMode(env);
  const status = options.status ?? (remoteOnly ? "remote_only" : "missing");
  const now = (options.now ?? (() => new Date()))();
  const ready = status === "ready";

  return {
    runtimeId: DOCUMENT_RUNTIME_ID,
    status,
    ready,
    updatedAt: now.toISOString(),
    source: "server",
    skills: DOCUMENT_RUNTIME_SKILLS.map((skill) => ({
      ...skill,
      ready,
      reason: status,
    })),
    package: {
      installedVersion: options.installedVersion ?? null,
      activePackage: options.activePackage ?? null,
      updateAvailable: status === "package_update_available",
      installing: status === "package_installing",
      rollback: status === "package_rollback",
      remoteOnly,
      progress: options.packageProgress ?? null,
    },
    repair: {
      available: false,
      inProgress: status === "repairing" || status === "package_installing",
      blockedReason: options.repairBlockedReason ?? "document_runtime_package_repair_not_configured",
      lastAttemptAt: null,
      lastError: options.repairLastError ?? null,
    },
    policy: {
      windowsWslRuntime: (options.platform ?? process.platform) === "win32"
        ? "disabled_by_product_policy"
        : "not_applicable",
    },
  };
}

export function createDocumentRuntimeStatusPayloadFromDoctor(
  result: DocumentRuntimeDoctorResult,
  dependencies: Partial<DocumentRuntimeRouteDependencies> = {},
): DocumentRuntimeStatusPayload {
  const status = normalizeDocumentRuntimeStatus(result.status ?? (result.ok ? "ready" : "failed"));
  const repairAvailable = status !== "ready" && Boolean(result.repairAvailable);
  const basePayload = createDocumentRuntimeStatusPayload({
    ...dependencies,
    status,
    installedVersion: result.packageVersion ?? null,
    activePackage: result.activePath ?? null,
    repairLastError: firstDoctorError(result),
  });
  return {
    ...basePayload,
    repair: {
      available: repairAvailable,
      inProgress: basePayload.repair.inProgress,
      blockedReason: status === "ready" || repairAvailable ? null : "document_runtime_package_repair_requires_updater_provider",
      lastAttemptAt: null,
      lastError: firstDoctorError(result),
    },
  };
}

export function createDocumentRuntimeStatusPayloadFromRepair(
  result: DocumentRuntimeRepairResult,
  dependencies: Partial<DocumentRuntimeRouteDependencies> = {},
): DocumentRuntimeStatusPayload {
  const doctor = result.doctor ?? {
    ok: result.ok,
    status: result.status,
  };
  const statusPayload = createDocumentRuntimeStatusPayloadFromDoctor(doctor, dependencies);
  const repairReason = result.reason?.trim() || statusPayload.repair.blockedReason;
  return {
    ...statusPayload,
    repair: {
      available: false,
      inProgress: false,
      blockedReason: statusPayload.ready ? null : repairReason,
      lastAttemptAt: (dependencies.now ?? (() => new Date()))().toISOString(),
      lastError: statusPayload.ready ? null : firstDoctorError(doctor) ?? repairReason,
    },
  };
}

function providerUnavailablePayload(error: unknown, dependencies: Partial<DocumentRuntimeRouteDependencies>): DocumentRuntimeStatusPayload {
  const message = error instanceof Error ? error.message : String(error);
  return createDocumentRuntimeStatusPayload({
    ...dependencies,
    status: "blocked",
    repairBlockedReason: "document_runtime_provider_unavailable",
    repairLastError: message,
  });
}

async function loadDefaultDocumentRuntimeProvider(): Promise<DocumentRuntimeProvider> {
  const moduleOverride = process.env.VESLO_DOCUMENT_RUNTIME_MODULE?.trim();
  const moduleUrl = moduleOverride || new URL("../../../document-runtime/src/index.mjs", import.meta.url).href;
  const loaded = await import(moduleUrl) as Partial<DocumentRuntimeProvider>;
  if (typeof loaded.doctor !== "function" || typeof loaded.repairHeadless !== "function") {
    throw new Error("Document runtime provider does not export doctor() and repairHeadless().");
  }
  return {
    doctor: loaded.doctor,
    repairHeadless: loaded.repairHeadless,
    ...(typeof loaded.installPackageFromFeed === "function" ? { installPackageFromFeed: loaded.installPackageFromFeed } : {}),
  };
}

export function createDocumentRuntimeProviderDependencies(
  providerLoader: () => Promise<DocumentRuntimeProvider> = loadDefaultDocumentRuntimeProvider,
  dependencies: Partial<DocumentRuntimeRouteDependencies> = {},
): DocumentRuntimeRouteDependencies {
  let installInFlight: Promise<void> | null = null;
  let installStartedAt: string | null = null;
  let lastInstallError: string | null = null;
  let installProgress: DocumentRuntimePackageInstallProgress | null = null;

  const setInstallProgress = (progress: DocumentRuntimePackageInstallProgress): void => {
    installProgress = {
      phase: progress.phase,
      artifactName: progress.artifactName ?? null,
      downloadedBytes: typeof progress.downloadedBytes === "number" ? progress.downloadedBytes : null,
      totalBytes: typeof progress.totalBytes === "number" ? progress.totalBytes : null,
      percent: typeof progress.percent === "number"
        ? Math.max(0, Math.min(100, Math.floor(progress.percent)))
        : null,
      message: progress.message ?? null,
    };
  };

  const installingPayload = (): DocumentRuntimeStatusPayload => {
    const payload = createDocumentRuntimeStatusPayload({
      ...dependencies,
      status: "package_installing",
      packageProgress: installProgress,
    });
    return {
      ...payload,
      repair: {
        available: false,
        inProgress: true,
        blockedReason: null,
        lastAttemptAt: installStartedAt,
        lastError: lastInstallError,
      },
    };
  };

  const withInstallAvailability = (
    result: DocumentRuntimeDoctorResult,
    provider: DocumentRuntimeProvider,
  ): DocumentRuntimeDoctorResult => {
    const status = normalizeDocumentRuntimeStatus(result.status ?? (result.ok ? "ready" : "failed"));
    if (!provider.installPackageFromFeed || status === "ready" || status === "remote_only" || status === "disabled_by_product_policy") {
      return result;
    }
    return {
      ...result,
      repairAvailable: true,
    };
  };

  const withLastInstallError = (payload: DocumentRuntimeStatusPayload): DocumentRuntimeStatusPayload => {
    if (payload.ready || !lastInstallError) return payload;
    return {
      ...payload,
      repair: {
        ...payload.repair,
        lastAttemptAt: payload.repair.lastAttemptAt ?? installStartedAt,
        lastError: payload.repair.lastError ?? lastInstallError,
      },
    };
  };

  const remoteOnlyPayload = (): DocumentRuntimeStatusPayload => createDocumentRuntimeStatusPayload({
    ...dependencies,
    env: dependencies.env ?? process.env,
    status: "remote_only",
    repairBlockedReason: "document_runtime_package_remote_only",
  });

  return {
    ...dependencies,
    readStatus: async () => {
      if (isRemoteOnlyMode(dependencies.env ?? process.env)) return remoteOnlyPayload();
      if (installInFlight) return installingPayload();
      try {
        const provider = await providerLoader();
        const result = await provider.doctor({ env: dependencies.env ?? process.env });
        return withLastInstallError(
          createDocumentRuntimeStatusPayloadFromDoctor(withInstallAvailability(result, provider), dependencies),
        );
      } catch (error) {
        return providerUnavailablePayload(error, dependencies);
      }
    },
    repair: async () => {
      if (isRemoteOnlyMode(dependencies.env ?? process.env)) return remoteOnlyPayload();
      if (installInFlight) return installingPayload();
      try {
        const provider = await providerLoader();
        if (provider.installPackageFromFeed) {
          installStartedAt = (dependencies.now ?? (() => new Date()))().toISOString();
          lastInstallError = null;
          setInstallProgress({
            phase: "feed",
            artifactName: null,
            downloadedBytes: null,
            totalBytes: null,
            percent: null,
            message: "Loading office document package feed.",
          });
          installInFlight = Promise.resolve()
            .then(async () => {
              const result = await provider.installPackageFromFeed!({
                env: dependencies.env ?? process.env,
                onProgress: setInstallProgress,
              });
              const payload = createDocumentRuntimeStatusPayloadFromRepair(result, dependencies);
              if (!payload.ready) {
                lastInstallError = payload.repair.lastError ?? payload.repair.blockedReason;
              }
            })
            .catch((error) => {
              lastInstallError = error instanceof Error ? error.message : String(error);
              setInstallProgress({
                phase: "failed",
                artifactName: installProgress?.artifactName ?? null,
                downloadedBytes: installProgress?.downloadedBytes ?? null,
                totalBytes: installProgress?.totalBytes ?? null,
                percent: null,
                message: lastInstallError,
              });
            })
            .finally(() => {
              installInFlight = null;
            });
          return installingPayload();
        }
        const result = await provider.repairHeadless({ env: dependencies.env ?? process.env });
        return createDocumentRuntimeStatusPayloadFromRepair(result, dependencies);
      } catch (error) {
        return {
          ...providerUnavailablePayload(error, dependencies),
          repair: {
            available: false,
            inProgress: false,
            blockedReason: "document_runtime_provider_unavailable",
            lastAttemptAt: (dependencies.now ?? (() => new Date()))().toISOString(),
            lastError: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}

export function registerDocumentRuntimeRoutes(
  routes: Route[],
  dependencies: DocumentRuntimeRouteDependencies = {},
): void {
  addRoute(routes, "GET", "/document-runtime/status", "client", async (ctx) => {
    const payload = dependencies.readStatus
      ? await dependencies.readStatus(ctx)
      : createDocumentRuntimeStatusPayload(dependencies);
    return jsonResponse(payload);
  });

  addRoute(routes, "POST", "/document-runtime/repair", "client", async (ctx) => {
    const payload = dependencies.repair
      ? await dependencies.repair(ctx)
      : createDocumentRuntimeStatusPayload({
          ...dependencies,
          repairBlockedReason: "document_runtime_package_repair_not_configured",
        });
    return jsonResponse(payload);
  });
}
