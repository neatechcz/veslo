export const REDACTED_SECRET_VALUE = "[REDACTED]";

function redactIfPresent(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.trim() ? REDACTED_SECRET_VALUE : value;
}

export function sanitizeRuntimePayloadForLogs<T extends Record<string, any>>(payload: T): T {
  return {
    ...payload,
    opencode: payload.opencode
      ? {
          ...payload.opencode,
          password: redactIfPresent(payload.opencode.password),
        }
      : payload.opencode,
    veslo: payload.veslo
      ? {
          ...payload.veslo,
          token: redactIfPresent(payload.veslo.token),
          hostToken: redactIfPresent(payload.veslo.hostToken),
        }
      : payload.veslo,
  };
}
