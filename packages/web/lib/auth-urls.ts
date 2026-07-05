import { deploymentServiceUrl } from "./deployment-endpoints";

const deploymentDomain = process.env.NEXT_PUBLIC_VESLO_DEPLOYMENT_DOMAIN ?? process.env.VESLO_DEPLOYMENT_DOMAIN;
const AUTH_BASE = (process.env.NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL ?? deploymentServiceUrl("app", deploymentDomain)).trim();
const DESKTOP_ONBOARDING_PARAM = "desktopOnboarding";

export function buildAuthCallbackUrl(pathname: string) {
  const url = new URL(pathname, AUTH_BASE || deploymentServiceUrl("app", deploymentDomain));

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
