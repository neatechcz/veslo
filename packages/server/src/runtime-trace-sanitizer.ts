export const REDACTED_RUNTIME_TRACE_VALUE = "[redacted]";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "apikey",
  "baseurl",
  "configdir",
  "content",
  "dataurl",
  "directory",
  "detail",
  "enginedirectory",
  "error",
  "message",
  "manifestpath",
  "password",
  "prompt",
  "resolvedtext",
  "rootdir",
  "secret",
  "skilldir",
  "sourcepath",
  "stagingroot",
  "targeturl",
  "text",
  "token",
  "warning",
  "workspacepath",
  "workspaceroot",
  "workdir",
]);

const WINDOWS_PATH = /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\)[^\s"')]+/;
const UNIX_PATH = /(?:^|[\s"'(])\/(?:Users|home|tmp|var)\/[^\s"')]+/;
const HTTP_URL = /https?:\/\/[^\s"')]+/i;
const CREDENTIAL =
  /\b(?:authorization|bearer|token|api[_-]?key|password)\s*[:=]\s*[^\s,;]+/i;

function isSensitiveKey(key: string | undefined): boolean {
  if (!key) return false;
  return SENSITIVE_KEYS.has(key.toLowerCase());
}

function hasSensitiveText(value: string): boolean {
  return (
    HTTP_URL.test(value) ||
    WINDOWS_PATH.test(value) ||
    UNIX_PATH.test(value) ||
    CREDENTIAL.test(value)
  );
}

export function sanitizeRuntimeTracePayload(
  value: unknown,
  key?: string,
): unknown {
  if (typeof value === "string") {
    return isSensitiveKey(key) || hasSensitiveText(value)
      ? REDACTED_RUNTIME_TRACE_VALUE
      : value;
  }
  if (Array.isArray(value))
    return value.map((item) => sanitizeRuntimeTracePayload(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeRuntimeTracePayload(childValue, childKey),
    ]),
  );
}
