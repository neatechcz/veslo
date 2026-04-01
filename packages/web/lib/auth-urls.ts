const AUTH_BASE = (process.env.NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL ?? "https://app.veslo.neatech.com").trim();

export function buildAuthCallbackUrl(pathname: string) {
  return new URL(pathname, AUTH_BASE || "https://app.veslo.neatech.com").toString();
}
