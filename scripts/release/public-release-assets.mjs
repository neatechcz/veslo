export const DEFAULT_PUBLIC_RELEASE_REPO = "neatechcz/veslo-updates";

const PUBLIC_DESKTOP_RELEASE_PREFIXES = [
  "veslo-desktop-darwin-",
  "veslo-desktop-windows-",
];

export function isPublicDesktopReleaseAsset(name) {
  if (typeof name !== "string") return false;
  return PUBLIC_DESKTOP_RELEASE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function publicDesktopReleaseAssetName(asset) {
  if (typeof asset === "string") {
    return isPublicDesktopReleaseAsset(asset) ? asset : "";
  }

  const name = asset?.name || "";
  if (isPublicDesktopReleaseAsset(name)) return name;

  const label = asset?.label || "";
  if (isPublicDesktopReleaseAsset(label)) return label;

  return "";
}

export function publicUpdaterEndpoint(repo = DEFAULT_PUBLIC_RELEASE_REPO) {
  return `https://github.com/${repo}/releases/latest/download/latest.json`;
}
