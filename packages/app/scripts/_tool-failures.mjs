const PROFILE_LOCK_PATTERNS = [
  "the browser is already running for",
  "use --isolated to run multiple browser instances",
];

const COMPLETED_FAILURE_MARKERS = [
  "timed out after waiting",
  "timeout waiting for",
  "operation timed out",
];

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readLooseText(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function hasCompletedFailureSignature(value) {
  const haystack = value.toLowerCase();
  const hasProfileLock = PROFILE_LOCK_PATTERNS.every((pattern) => haystack.includes(pattern));
  if (hasProfileLock) return true;
  return COMPLETED_FAILURE_MARKERS.some((pattern) => haystack.includes(pattern));
}

function formatUnexpectedToolError(input) {
  const details = [input.title, input.error, input.detail, input.output].filter(Boolean).join(" ").trim();
  if (details) {
    return `Unexpected tool error (${input.tool}): ${details}`;
  }
  return `Unexpected tool error (${input.tool})`;
}

export function getUnexpectedToolFailure(part) {
  if (!part || part.type !== "tool") return null;

  const state = part.state && typeof part.state === "object" ? part.state : {};
  const status = readString(state.status).toLowerCase();
  const tool = readString(part.tool) || "tool";
  const title = readString(state.title);
  const error = readString(state.error);
  const detail = readString(state.detail);
  const output = readLooseText(state.output);

  if (status === "error") {
    return formatUnexpectedToolError({ tool, title, error, detail, output });
  }

  if (status !== "completed") return null;

  const combined = [title, error, detail, output].filter(Boolean).join("\n");
  if (!combined) return null;
  if (!hasCompletedFailureSignature(combined)) return null;

  return formatUnexpectedToolError({ tool, title, error, detail, output });
}

export function findUnexpectedToolFailure(parts) {
  for (const part of parts) {
    const message = getUnexpectedToolFailure(part);
    if (message) return message;
  }
  return null;
}
