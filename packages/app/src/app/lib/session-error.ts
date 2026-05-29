import { formatManagedAiAccessError } from "./ai-gateway-errors";

const truncateErrorField = (value: unknown, max = 500) => {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
};

const inferHttpStatus = (value: string | null) => {
  if (!value) return null;
  const match = value.match(/\b(?:status|code|http)\s*(?:=|:)?\s*(401|403|413|429)\b/i) ||
    value.match(/\b(401|403|413|429)\b/);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
};

const getNestedRecords = (source: Record<string, unknown>) => {
  const records: Record<string, unknown>[] = [source];
  const data = source.data;
  if (data && typeof data === "object") records.push(data as Record<string, unknown>);
  const cause = source.cause;
  if (cause && typeof cause === "object") {
    const causeRecord = cause as Record<string, unknown>;
    records.push(causeRecord);
    const causeData = causeRecord.data;
    if (causeData && typeof causeData === "object") records.push(causeData as Record<string, unknown>);
  }
  return records;
};

const firstStringField = (records: Record<string, unknown>[], keys: string[]) => {
  for (const record of records) {
    for (const key of keys) {
      const value = truncateErrorField(record[key], 800);
      if (value) return value;
    }
  }
  return null;
};

const firstNumberField = (records: Record<string, unknown>[], keys: string[]) => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      return value;
    }
  }
  return null;
};

const firstBooleanField = (records: Record<string, unknown>[], keys: string[]) => {
  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value !== "boolean") continue;
      return value;
    }
  }
  return null;
};

type ParsedApiErrorBody = {
  message: string | null;
  type: string | null;
  param: string | null;
  code: string | null;
};

const parseApiErrorBody = (responseBody: string | null): ParsedApiErrorBody | null => {
  if (!responseBody) return null;
  try {
    const parsed = JSON.parse(responseBody) as {
      error?: {
        message?: unknown;
        type?: unknown;
        param?: unknown;
        code?: unknown;
      };
    } | null;
    const apiError = parsed?.error;
    if (!apiError || typeof apiError !== "object") return null;
    return {
      message: truncateErrorField(apiError.message, 800),
      type: truncateErrorField(apiError.type, 200),
      param: truncateErrorField(apiError.param, 200),
      code: truncateErrorField(apiError.code, 200),
    };
  } catch {
    return null;
  }
};

const isInvalidFileInputError = (options: {
  code: string | null;
  rawMessage: string | null;
  parsedApiError: ParsedApiErrorBody | null;
}) => {
  const code = (options.code ?? "").toLowerCase();
  const rawMessage = (options.rawMessage ?? "").toLowerCase();
  const parsedCode = (options.parsedApiError?.code ?? "").toLowerCase();
  const parsedType = (options.parsedApiError?.type ?? "").toLowerCase();
  const parsedParam = (options.parsedApiError?.param ?? "").toLowerCase();
  const parsedMessage = (options.parsedApiError?.message ?? "").toLowerCase();

  if (code === "invalid_file" || parsedCode === "invalid_file") return true;
  if (rawMessage.includes("invalid_file")) return true;
  if (
    parsedType === "invalid_request_error" &&
    parsedParam === "input" &&
    parsedMessage.includes("file") &&
    (parsedMessage.includes("corrupt") || parsedMessage.includes("formatted") || parsedMessage.includes("invalid"))
  ) {
    return true;
  }
  return false;
};

export const formatSessionError = (errorObj: Record<string, unknown>) => {
  const managedAiAccessError = formatManagedAiAccessError(errorObj);
  if (managedAiAccessError) return managedAiAccessError;

  const records = getNestedRecords(errorObj);
  const errorName = typeof errorObj.name === "string" ? errorObj.name : "UnknownError";
  const rawMessage = firstStringField(records, ["message", "detail", "reason"]);
  const responseBody = firstStringField(records, ["responseBody", "body", "response"]);
  const parsedApiError = parseApiErrorBody(responseBody);
  const providerID = firstStringField(records, ["providerID", "providerId", "provider"]);
  const code = firstStringField(records, ["code", "errorCode"]) ?? parsedApiError?.code ?? null;
  const statusCode = firstNumberField(records, ["statusCode", "status"]);
  const inferred = inferHttpStatus(rawMessage) ?? inferHttpStatus(responseBody);
  const effectiveStatus = statusCode ?? inferred;
  const isRetryable = firstBooleanField(records, ["isRetryable", "retryable"]);
  const isInvalidFile = isInvalidFileInputError({ code, rawMessage, parsedApiError });

  const heading = (() => {
    if (isInvalidFile) return "Invalid file";
    if (errorName === "ProviderAuthError") return `Provider auth error${providerID ? ` (${providerID})` : ""}`;
    if (errorName === "APIError") {
      if (effectiveStatus === 401 || effectiveStatus === 403) return "Authentication failed";
      if (effectiveStatus === 413) return "Context too large";
      if (effectiveStatus === 429) return "Rate limit exceeded";
      return `API error${effectiveStatus ? ` (${effectiveStatus})` : ""}`;
    }
    if (effectiveStatus === 401 || effectiveStatus === 403) return "Authentication failed";
    if (effectiveStatus === 413) return "Context too large";
    if (effectiveStatus === 429) return "Rate limit exceeded";
    if (errorName === "MessageOutputLengthError") return "Output length limit exceeded";
    return errorName.replace(/([a-z])([A-Z])/g, "$1 $2");
  })();

  const lines = [heading];
  if (isInvalidFile) {
    lines.push("One of the uploaded files is invalid or corrupted. Replace it with a valid file and try again.");
    return lines.join("\n");
  }

  if (rawMessage && rawMessage !== heading) lines.push(rawMessage);
  if (effectiveStatus === 413) {
    lines.push("Tip: Try compacting the session, or start a new session if the issue persists.");
  }
  if (providerID && errorName !== "ProviderAuthError") lines.push(`Provider: ${providerID}`);
  if (effectiveStatus && errorName !== "APIError") lines.push(`Status: ${effectiveStatus}`);
  if (code) lines.push(`Code: ${code}`);
  if (isRetryable !== null) lines.push(`Retryable: ${isRetryable ? "yes" : "no"}`);
  if (responseBody) lines.push(`Response: ${responseBody}`);
  return lines.join("\n");
};

export { truncateErrorField };
