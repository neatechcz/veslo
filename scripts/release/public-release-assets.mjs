export const DEFAULT_PUBLIC_RELEASE_REPO = "neatechcz/veslo-updates";

const PUBLIC_DESKTOP_RELEASE_PREFIXES = [
  "veslo-desktop-darwin-",
  "veslo-desktop-windows-",
];

export function isPublicDesktopReleaseAsset(name) {
  if (typeof name !== "string") return false;
  return PUBLIC_DESKTOP_RELEASE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function publicUpdaterEndpoint(repo = DEFAULT_PUBLIC_RELEASE_REPO) {
  return `https://github.com/${repo}/releases/latest/download/latest.json`;
}
