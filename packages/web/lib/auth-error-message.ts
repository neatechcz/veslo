const COMPANY_EMAIL_REQUIRED_MESSAGE =
  "Use your company email to register. Personal email addresses are not supported. If your organization invited you, open the registration link from that invitation.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getAuthErrorMessage(payload: unknown, fallback: string): string {
  if (typeof payload === "string" && payload.trim().length > 0) {
    const trimmed = payload.trim();
    const lower = trimmed.toLowerCase();
    if (lower.startsWith("<!doctype") || lower.startsWith("<html") || lower.includes("<body")) {
      return `${fallback} Upstream returned an HTML error page.`;
    }
    if (trimmed.length > 240) {
      return `${fallback} Upstream returned a non-JSON error payload.`;
    }
    return trimmed;
  }

  if (!isRecord(payload)) {
    return fallback;
  }

  if (
    payload.code === "domain_not_allowed" ||
    payload.error === "domain_not_allowed" ||
    payload.message === "domain_not_allowed"
  ) {
    return COMPANY_EMAIL_REQUIRED_MESSAGE;
  }

  const message = payload.message;
  if (typeof message === "string" && message.trim().length > 0) {
    return message;
  }

  const error = payload.error;
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return fallback;
}
