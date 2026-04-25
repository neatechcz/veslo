export type SafeDenAuthSummary = {
  denApiBase: string | null;
  orgId: string | null;
  userEmail: string | null;
  hasToken: boolean;
};

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function isLoopbackDenApiBase(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.startsWith("http://127.0.0.1")
    || normalized.startsWith("https://127.0.0.1")
    || normalized.startsWith("http://localhost")
    || normalized.startsWith("https://localhost")
    || normalized.startsWith("http://[::1]")
    || normalized.startsWith("https://[::1]")
    || normalized.startsWith("http://0.0.0.0")
    || normalized.startsWith("https://0.0.0.0");
}

export function parseSafeDenAuthSummary(raw: string | null | undefined): SafeDenAuthSummary | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as {
      denApiBase?: unknown;
      token?: unknown;
      orgId?: unknown;
      user?: { email?: unknown };
    };

    return {
      denApiBase: readString(parsed.denApiBase),
      orgId: readString(parsed.orgId),
      userEmail: readString(parsed.user?.email),
      hasToken: Boolean(readString(parsed.token)),
    };
  } catch {
    return null;
  }
}

export function hasExplicitLiveFeedbackDenAuth(env?: { E2E_DEN_AUTH_JSON?: string }) {
  const value = env?.E2E_DEN_AUTH_JSON ?? process.env.E2E_DEN_AUTH_JSON;
  return typeof value === "string" && value.trim().length > 0;
}

export function shouldRepairDenAuthForLiveFeedback(
  current: SafeDenAuthSummary | null,
  replacement: SafeDenAuthSummary | null,
) {
  if (!current?.denApiBase || !isLoopbackDenApiBase(current.denApiBase)) return false;
  if (!replacement?.denApiBase || isLoopbackDenApiBase(replacement.denApiBase)) return false;
  return Boolean(replacement.orgId && replacement.hasToken);
}
