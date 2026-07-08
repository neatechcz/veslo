import { formatManagedAiAccessError } from "./ai-gateway-errors";
import { safeStringify } from "../utils";
import { currentLocale, t } from "../../i18n";

const tr = (key: string, replacements?: Record<string, string>): string => {
  let value = t(key, currentLocale());
  if (replacements) {
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      value = value.replaceAll(`{${placeholder}}`, replacement);
    }
  }
  return value;
};

export const describeRequestError = (error: unknown, fallback: string): string => {
  const managedAiAccessError = formatManagedAiAccessError(error);
  if (managedAiAccessError) return managedAiAccessError;

  const readString = (value: unknown, max = 700) => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length <= max) return trimmed;
    return `${trimmed.slice(0, Math.max(0, max - 3))}...`;
  };

  const records: Record<string, unknown>[] = [];
  const root = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  if (root) {
    records.push(root);
    if (root.data && typeof root.data === "object") records.push(root.data as Record<string, unknown>);
    if (root.cause && typeof root.cause === "object") {
      const cause = root.cause as Record<string, unknown>;
      records.push(cause);
      if (cause.data && typeof cause.data === "object") records.push(cause.data as Record<string, unknown>);
    }
  }

  const firstString = (keys: string[]) => {
    for (const record of records) {
      for (const key of keys) {
        const value = readString(record[key]);
        if (value) return value;
      }
    }
    return null;
  };

  const firstNumber = (keys: string[]) => {
    for (const record of records) {
      for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) return value;
      }
    }
    return null;
  };

  const status = firstNumber(["statusCode", "status"]);
  const provider = firstString(["providerID", "providerId", "provider"]);
  const code = firstString(["code", "errorCode"]);
  const response = firstString(["responseBody", "body", "response"]);
  const raw =
    (error instanceof Error ? readString(error.message) : null) ||
    firstString(["message", "detail", "reason", "error"]) ||
    (typeof error === "string" ? readString(error) : null);

  const generic = raw && /^unknown\s+error$/i.test(raw);
  const heading = (() => {
    if (status === 401 || status === 403) return tr("errors.authentication_failed");
    if (status === 429) return tr("errors.rate_limit_exceeded");
    if (provider) return tr("errors.provider_error", { provider });
    return fallback;
  })();

  const lines = [heading];
  if (raw && !generic && raw !== heading) lines.push(raw);
  if (status && !heading.includes(String(status))) lines.push(tr("errors.status_label", { status: String(status) }));
  if (provider && !heading.includes(provider)) lines.push(tr("errors.provider_label", { provider }));
  if (code) lines.push(tr("errors.code_label", { code }));
  if (response) lines.push(tr("errors.response_label", { response }));
  if (lines.length > 1) return lines.join("\n");

  if (raw && !generic) return raw;
  if (error && typeof error === "object") {
    const serialized = safeStringify(error);
    if (serialized && serialized !== "{}") return serialized;
  }
  return fallback;
};

const assertNoClientError = (result: unknown): void => {
  const maybe = result as { error?: unknown } | null | undefined;
  if (!maybe || maybe.error === undefined) return;
  throw new Error(describeRequestError(maybe.error, tr("errors.request_failed")));
};
