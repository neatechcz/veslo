import * as Sentry from "@sentry/browser";
import {
  normalizeVesloServerResponseDiagnostic,
  VesloServerError,
} from "./veslo-server/transport";

type ErrorMonitoringPlatform = "desktop" | "web";
export type ErrorMonitoringSeverity = "warning" | "error";

type ErrorMonitoringEnv = {
  DEV?: boolean;
  PROD?: boolean;
  VITE_VESLO_GLITCHTIP_DSN?: string;
  VITE_VESLO_GLITCHTIP_ENABLED?: string;
  VITE_VESLO_GLITCHTIP_ENVIRONMENT?: string;
  VITE_VESLO_GLITCHTIP_TRACES_SAMPLE_RATE?: string;
};

type ErrorMonitoringOptions = {
  appVersion: string;
  platform: ErrorMonitoringPlatform;
};

export type ErrorMonitoringConfig = {
  enabled: boolean;
  dsn?: string;
  environment: string;
  release: string;
  tracesSampleRate: number;
  platform: ErrorMonitoringPlatform;
};

export type ErrorMonitoringScope = {
  setTag(key: string, value: string): void;
  setContext(key: string, value: unknown): void;
  setLevel(level: ErrorMonitoringSeverity): void;
};

export type ErrorMonitoringClient = {
  init?(options: Sentry.BrowserOptions): void;
  withScope(callback: (scope: ErrorMonitoringScope) => void): void;
  captureException(error: unknown): unknown;
  captureMessage(message: string): unknown;
};

let activeClient: ErrorMonitoringClient | null = null;
let initialized = false;

function normalizeFlag(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function isExplicitlyDisabled(value: string | undefined): boolean {
  return ["0", "false", "no", "off"].includes(normalizeFlag(value));
}

function parseTracesSampleRate(value: string | undefined): number {
  if (!value?.trim()) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function stripSensitiveEventData(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
  delete event.user;

  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    delete event.request.headers;
  }

  return event;
}

function glitchTipDefaultIntegrations(): Sentry.BrowserOptions["defaultIntegrations"] {
  return Sentry.getDefaultIntegrations({}).filter(
    integration => integration.name !== "BrowserSession",
  );
}

export function resolveErrorMonitoringConfig(
  env: ErrorMonitoringEnv,
  options: ErrorMonitoringOptions,
): ErrorMonitoringConfig {
  const dsn = env.VITE_VESLO_GLITCHTIP_DSN?.trim();
  const environment =
    env.VITE_VESLO_GLITCHTIP_ENVIRONMENT?.trim() ||
    (env.PROD ? "production" : "development");

  return {
    enabled: Boolean(dsn) && !isExplicitlyDisabled(env.VITE_VESLO_GLITCHTIP_ENABLED),
    dsn: dsn || undefined,
    environment,
    release: `veslo@${options.appVersion}`,
    tracesSampleRate: parseTracesSampleRate(env.VITE_VESLO_GLITCHTIP_TRACES_SAMPLE_RATE),
    platform: options.platform,
  };
}

export function initErrorMonitoring(
  env: ErrorMonitoringEnv,
  options: ErrorMonitoringOptions,
  client: ErrorMonitoringClient = Sentry,
): ErrorMonitoringConfig {
  const config = resolveErrorMonitoringConfig(env, options);

  if (!config.enabled || initialized || !config.dsn || typeof client.init !== "function") {
    return config;
  }

  client.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    tracesSampleRate: config.tracesSampleRate,
    sendDefaultPii: false,
    defaultIntegrations: glitchTipDefaultIntegrations(),
    beforeSend: stripSensitiveEventData,
    initialScope: {
      tags: {
        app: "veslo",
        platform: config.platform,
      },
    },
  });

  activeClient = client;
  initialized = true;
  return config;
}

export function captureReportedError(
  error: unknown,
  context: string,
  severity: ErrorMonitoringSeverity,
  client: ErrorMonitoringClient | null = activeClient,
): void {
  if (!client) return;

  client.withScope(scope => {
    scope.setTag("veslo.context", context);
    scope.setTag("veslo.severity", severity);
    scope.setLevel(severity);
    scope.setContext("veslo", {
      context,
      severity,
    });

    const responseDiagnostic =
      error instanceof VesloServerError
        ? normalizeVesloServerResponseDiagnostic(error.responseDiagnostic)
        : undefined;
    if (responseDiagnostic) {
      scope.setTag("veslo.response_kind", responseDiagnostic.responseKind);
      scope.setTag("veslo.http_status", String(responseDiagnostic.httpStatus));
      scope.setTag("veslo.response_media_type", responseDiagnostic.mediaType);
      scope.setContext("veslo.server_response", responseDiagnostic);
    }

    if (error instanceof Error) {
      client.captureException(error);
      return;
    }

    client.captureMessage(safeMessage(error));
  });
}

export function setErrorMonitoringClientForTests(client: ErrorMonitoringClient | null): void {
  activeClient = client;
}

export function resetErrorMonitoringForTests(): void {
  activeClient = null;
  initialized = false;
}
