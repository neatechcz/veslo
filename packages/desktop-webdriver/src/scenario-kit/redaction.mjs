const secretPattern = /((?:authorization|token|api[_-]?key|password)\s*[:=]\s*)([^\s,"'}]+)/gi;

export function sanitizeScenarioArtifactValue(value, depth = 0) {
  if (depth > 8) return "[truncated-depth]";
  if (typeof value === "string") return value.replace(secretPattern, "$1[redacted]");
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeScenarioArtifactValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).slice(0, 100).map(([key, item]) => [key, /token|secret|password|authorization|api[_-]?key/i.test(key)
      ? "[redacted]"
      : sanitizeScenarioArtifactValue(item, depth + 1)]),
  );
}
