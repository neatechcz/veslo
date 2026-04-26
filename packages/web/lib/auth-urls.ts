const AUTH_BASE = (process.env.NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL ?? "https://app.veslo.neatech.com").trim();
const DESKTOP_ONBOARDING_PARAM = "desktopOnboarding";

export function buildAuthCallbackUrl(pathname: string) {
  const url = new URL(pathname, AUTH_BASE || "https://app.veslo.neatech.com");

  if (typeof window !== "undefined") {
    const currentParams = new URLSearchParams(window.location.search);
    if (currentParams.get(DESKTOP_ONBOARDING_PARAM) === "1") {
      for (const [key, value] of currentParams.entries()) {
        url.searchParams.set(key, value);
      }
    }
  }

  return url.toString();
}
