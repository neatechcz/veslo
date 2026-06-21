export type NewSessionDisabledReason =
  | "available"
  | "runtimeConnecting"
  | "runtimeUnreachable"
  | "noRuntimeClient"
  | "missingWorkspaceRoot"
  | "missingQuickChatHandler"
  | "unknown";

export type DiagnosticsLane =
  | "desktop-bootstrap"
  | "veslo-server-launch"
  | "veslo-server-supervised-output"
  | "delivery-state";

export type DiagnosticsDeliveryPath = "local-server" | "desktop-direct-fallback";

export type NewSessionDisabledReasonInput = {
  runtimeConnecting?: boolean;
  runtimeUnreachable?: boolean;
  hasRuntimeClient?: boolean;
  hasWorkspaceRoot?: boolean;
  workspaceRoot?: string | null;
  hasQuickChatHandler?: boolean;
};

export type NewSessionDisabledInput = NewSessionDisabledReasonInput;

export type BootstrapDiagnosticsCloudContext = {
  denApiBase?: string | null;
  token?: string | null;
  userId?: string | null;
  orgId?: string | null;
  workspaceId?: string | null;
};

export type NormalizedBootstrapDiagnosticsCloudContext = {
  denApiBase: string;
  token: string;
  userId: string;
  orgId: string;
  workspaceId?: string;
};

const REDACTED = "[redacted]";
const REDACTED_HOME = "[redacted-home]";
const PROCESS_OUTPUT_KEYS = new Set(["stderr", "stdout", "tail"]);
const PROCESS_OUTPUT_LIMIT = 2_000;

export function classifyNewSessionDisabledReason(input: NewSessionDisabledReasonInput): NewSessionDisabledReason {
  if (input.runtimeConnecting) return "runtimeConnecting";
  if (input.runtimeUnreachable) return "runtimeUnreachable";
  if (input.hasRuntimeClient === false) return "noRuntimeClient";
  const hasWorkspaceRoot = input.hasWorkspaceRoot ?? Boolean(input.workspaceRoot);
  if (!hasWorkspaceRoot) return "missingWorkspaceRoot";
  if (input.hasQuickChatHandler === false) return "missingQuickChatHandler";
  if (input.hasRuntimeClient === true && input.hasQuickChatHandler === true) return "available";
  return "unknown";
}

export function sanitizeBootstrapDiagnosticPayload<T>(value: T): T {
  return sanitizeValue(value) as T;
}

export async function recordBootstrapDiagnostic(eventType: DiagnosticsLane | string, payload: unknown = {}): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("record_bootstrap_diagnostic", {
      eventType,
      payload: sanitizeBootstrapDiagnosticPayload(payload),
    });
  } catch {
    // Diagnostics must never interrupt the app flow they are describing.
  }
}

export function normalizeBootstrapDiagnosticsCloudContext(
  context: BootstrapDiagnosticsCloudContext,
): NormalizedBootstrapDiagnosticsCloudContext | null {
  const denApiBase = context.denApiBase?.trim() ?? "";
  const token = context.token?.trim() ?? "";
  const userId = context.userId?.trim() ?? "";
  const orgId = context.orgId?.trim() ?? "";
  const workspaceId = context.workspaceId?.trim() ?? "";

  if (!denApiBase || !token || !userId || !orgId) return null;

  return {
    denApiBase,
    token,
    userId,
    orgId,
    ...(workspaceId ? { workspaceId } : {}),
  };
}

export async function setBootstrapDiagnosticsCloudContext(
  context: BootstrapDiagnosticsCloudContext,
): Promise<void> {
  const normalizedContext = normalizeBootstrapDiagnosticsCloudContext(context);
  if (!normalizedContext) {
    await clearBootstrapDiagnosticsCloudContext();
    return;
  }

  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("set_bootstrap_diagnostics_cloud_context", normalizedContext);
  } catch {
    // Diagnostics must never interrupt the app flow they are describing.
  }
}

export async function clearBootstrapDiagnosticsCloudContext(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("clear_bootstrap_diagnostics_cloud_context");
  } catch {
    // Diagnostics must never interrupt the app flow they are describing.
  }
}

function sanitizeValue(value: unknown, key?: string): unknown {
  if (isSecretKey(key)) return REDACTED;

  if (typeof value === "string") {
    const sanitized = redactInlineAuthorization(redactHomePaths(stripUrlQueryValues(value)));
    return PROCESS_OUTPUT_KEYS.has(String(key ?? "").toLowerCase()) ? truncateProcessOutput(sanitized) : sanitized;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      output[entryKey] = sanitizeValue(entryValue, entryKey);
    }
    return output;
  }

  return value;
}

function isSecretKey(key: string | undefined): boolean {
  if (!key) return false;
  return /(?:token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|code|verifier)/i.test(key)
    || /(?:^|[-_])key$/i.test(key);
}

function stripUrlQueryValues(value: string): string {
  return value.replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
    try {
      const url = new URL(match);
      if (!url.search) return match;
      return `${url.origin}${url.pathname}?${url.hash}`;
    } catch {
      return match;
    }
  });
}

function redactInlineAuthorization(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bAuthorization\s*[:=]\s*(?!Bearer\b)[^\s,;]+/gi, "Authorization: [redacted]");
}

function redactHomePaths(value: string): string {
  return value
    .replace(/\/Users\/[^/\s"'<>]+/g, REDACTED_HOME)
    .replace(/\/home\/[^/\s"'<>]+/g, REDACTED_HOME)
    .replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+/g, REDACTED_HOME);
}

function truncateProcessOutput(value: string): string {
  if (value.length <= PROCESS_OUTPUT_LIMIT) return value;
  return `${value.slice(0, PROCESS_OUTPUT_LIMIT)}...[truncated]`;
}
