export const DEFAULT_PUBLIC_RELEASE_REPO = "neatechcz/veslo-updates";
export const DOCUMENT_RUNTIME_PACKAGE_FEED_NAME = "document-runtime-packages.json";

const PUBLIC_DESKTOP_RELEASE_PREFIXES = [
  "veslo-desktop-darwin-",
  "veslo-desktop-windows-",
];

const DOCUMENT_RUNTIME_PACKAGE_PREFIX = "veslo-document-runtime-";
const DOCUMENT_RUNTIME_PACKAGE_SUFFIX = ".veslopkg";

export function isPublicDesktopReleaseAsset(name) {
  if (typeof name !== "string") return false;
  return PUBLIC_DESKTOP_RELEASE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isPublicDocumentRuntimeReleaseAsset(name) {
  if (typeof name !== "string") return false;
  return (
    name === DOCUMENT_RUNTIME_PACKAGE_FEED_NAME ||
    (name.startsWith(DOCUMENT_RUNTIME_PACKAGE_PREFIX) &&
      (name.endsWith(DOCUMENT_RUNTIME_PACKAGE_SUFFIX) || name.endsWith(`${DOCUMENT_RUNTIME_PACKAGE_SUFFIX}.sig`)))
  );
}

export function isPublicReleaseAsset(name) {
  return isPublicDesktopReleaseAsset(name) || isPublicDocumentRuntimeReleaseAsset(name);
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

export function publicDocumentRuntimeReleaseAssetName(asset) {
  if (typeof asset === "string") {
    return isPublicDocumentRuntimeReleaseAsset(asset) ? asset : "";
  }

  const name = asset?.name || "";
  if (isPublicDocumentRuntimeReleaseAsset(name)) return name;

  const label = asset?.label || "";
  if (isPublicDocumentRuntimeReleaseAsset(label)) return label;

  return "";
}

export function publicReleaseAssetName(asset) {
  return publicDesktopReleaseAssetName(asset) || publicDocumentRuntimeReleaseAssetName(asset);
}

export function publicUpdaterEndpoint(repo = DEFAULT_PUBLIC_RELEASE_REPO) {
  return `https://github.com/${repo}/releases/latest/download/latest.json`;
}

export function publicDocumentRuntimePackageFeedEndpoint(repo = DEFAULT_PUBLIC_RELEASE_REPO) {
  return `https://github.com/${repo}/releases/latest/download/${DOCUMENT_RUNTIME_PACKAGE_FEED_NAME}`;
}
