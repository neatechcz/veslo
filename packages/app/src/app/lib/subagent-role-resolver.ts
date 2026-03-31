import {
  normalizeSubagentLocale,
  normalizeSubagentRoleKey,
  type SubagentLocale,
} from "./subagent-decoration-model.js";

export type SubagentRoleResolution = {
  roleKey: string;
  roleLabel: string;
  firstName: string;
};

export type SubagentRoleResolverDeps = {
  runAiClassifier: (input: { locale: SubagentLocale; prompt: string }) => Promise<string>;
  classifyDeterministic: (input: { locale: SubagentLocale; prompt: string }) => SubagentRoleResolution;
};

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

function normalizeFirstName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

function withTimeoutOrThrow<T>(
  promise: Promise<T>,
  input: { timeoutMs: number; label: string },
): Promise<T> {
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 0;
  if (timeoutMs <= 0) return promise;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${input.label} after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function normalizeResolvedRole(value: unknown): SubagentRoleResolution | null {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  if (!record) return null;

  const roleKey = normalizeSubagentRoleKey(record.role_key);
  const roleLabel = normalizeLabel(record.role_label);
  const firstName = normalizeFirstName(record.first_name);
  if (!roleKey || !roleLabel || !firstName) return null;

  return {
    roleKey,
    roleLabel,
    firstName,
  };
}

function parseAiClassifierResponse(raw: string): SubagentRoleResolution | null {
  if (!raw.trim()) return null;
  try {
    return normalizeResolvedRole(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function resolveSubagentRole(
  input: { locale: SubagentLocale; prompt: string; timeoutMs?: number },
  deps: SubagentRoleResolverDeps,
): Promise<SubagentRoleResolution> {
  const locale = normalizeSubagentLocale(input.locale);
  if (!locale) {
    throw new Error("Invalid subagent locale.");
  }

  const timeoutMs = Number.isFinite(input.timeoutMs ?? 0) ? (input.timeoutMs ?? 0) : 0;

  try {
    const aiResponse = await withTimeoutOrThrow(
      deps.runAiClassifier({ locale, prompt: input.prompt }),
      { timeoutMs, label: "subagent role classifier" },
    );
    const parsed = parseAiClassifierResponse(aiResponse);
    if (parsed) return parsed;
  } catch {
    // Deterministic fallback below.
  }

  const fallback = deps.classifyDeterministic({ locale, prompt: input.prompt });
  const normalizedFallback = normalizeResolvedRole({
    role_key: fallback.roleKey,
    role_label: fallback.roleLabel,
    first_name: fallback.firstName,
  });

  if (!normalizedFallback) {
    throw new Error("Deterministic subagent role classifier returned an invalid value.");
  }

  return normalizedFallback;
}
