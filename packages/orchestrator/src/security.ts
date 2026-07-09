export const REDACTED_SECRET_VALUE = "[REDACTED]";

function redactIfPresent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.trim() ? REDACTED_SECRET_VALUE : value;
}

function recordFromValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function sanitizeRuntimePayloadForLogs<T extends Record<string, unknown>>(payload: T): T {
  const opencode = recordFromValue(payload.opencode);
  const veslo = recordFromValue(payload.veslo);
  return {
    ...payload,
    opencode: payload.opencode
      ? {
          ...opencode,
          password: redactIfPresent(opencode.password),
        }
      : payload.opencode,
    veslo: payload.veslo
      ? {
          ...veslo,
          token: redactIfPresent(veslo.token),
          hostToken: redactIfPresent(veslo.hostToken),
        }
      : payload.veslo,
  } as T;
}
