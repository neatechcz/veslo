export const DOCUMENT_RUNTIME_SCHEMA_VERSION = 1;
export const DOCUMENT_RUNTIME_PACKAGE_ID = "veslo-document-runtime";
export const DOCUMENT_RUNTIME_PACKAGE_FEED_NAME = "document-runtime-packages.json";
export const PACKAGE_EXTENSION = ".veslopkg";

export const SUPPORTED_PLATFORMS = [
  "windows-native-x64",
  "macos-arm64",
  "macos-x64",
  "linux-x64",
];

export const CHANNELS = ["stable", "prerelease", "internal-dev"];

const SHA256_RE = /^[a-f0-9]{64}$/i;
const CALVER_RE = /^\d{4}\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const HTTPS_URL_RE = /^https:\/\/[^\s]+$/;

const REQUIRED_TOOLS = ["soffice", "pandoc", "poppler", "qpdf", "python", "node"];

const isPlainObject = (value) => {
  return value !== null && typeof value === "object" && !Array.isArray(value);
};

const push = (errors, path, message) => {
  errors.push(`${path}: ${message}`);
};

const requireString = (errors, value, path, { pattern, expected } = {}) => {
  if (typeof value !== "string" || value.trim() === "") {
    push(errors, path, "must be a non-empty string");
    return;
  }
  if (pattern && !pattern.test(value)) {
    push(errors, path, expected ? `must match ${expected}` : "has invalid format");
  }
};

const requireEnum = (errors, value, path, choices) => {
  if (!choices.includes(value)) {
    push(errors, path, `must be one of: ${choices.join(", ")}`);
  }
};

const requireSha256 = (errors, value, path) => {
  requireString(errors, value, path, {
    pattern: SHA256_RE,
    expected: "a 64-character sha256 hex digest",
  });
};

const requireCalVer = (errors, value, path) => {
  requireString(errors, value, path, {
    pattern: CALVER_RE,
    expected: "CalVer YYYY.M.P",
  });
};

const requireHttpsUrl = (errors, value, path) => {
  requireString(errors, value, path, {
    pattern: HTTPS_URL_RE,
    expected: "an https URL",
  });
};

const assertValid = (errors, label) => {
  if (errors.length > 0) {
    throw new Error(`${label} is invalid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }
};

export function compareCalVerVersions(a, b) {
  const left = String(a || "").split(/[^\d]+/).filter(Boolean).map(Number);
  const right = String(b || "").split(/[^\d]+/).filter(Boolean).map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] || 0) - (right[index] || 0);
    if (delta) return delta;
  }
  return String(a || "").localeCompare(String(b || ""));
}

export function selectPackageFeedEntry(feed, {
  platform,
  channel = "stable",
  currentVersion = null,
  appVersion = null,
} = {}) {
  const validated = validatePackageFeed(feed);
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported document runtime platform: ${platform || "(missing)"}`);
  }

  const candidates = validated.packages
    .filter((entry) => entry.platform === platform)
    .filter((entry) => entry.channel === channel)
    .filter((entry) => !appVersion || compareCalVerVersions(appVersion, entry.minimumAppVersion) >= 0)
    .filter((entry) => !currentVersion || compareCalVerVersions(entry.packageVersion, currentVersion) > 0)
    .sort((a, b) => compareCalVerVersions(b.packageVersion, a.packageVersion));

  return candidates[0] ?? null;
}

export function documentRuntimePackageAssetName({ platform, packageVersion }) {
  const errors = [];
  requireEnum(errors, platform, "platform", SUPPORTED_PLATFORMS);
  requireCalVer(errors, packageVersion, "packageVersion");
  assertValid(errors, "document runtime package asset name");
  return `${DOCUMENT_RUNTIME_PACKAGE_ID}-${platform}-${packageVersion}${PACKAGE_EXTENSION}`;
}

export function documentRuntimePackageSignatureName(input) {
  return `${documentRuntimePackageAssetName(input)}.sig`;
}

export function packageFeedEndpoint(repo = "neatechcz/veslo-updates") {
  return `https://github.com/${repo}/releases/latest/download/${DOCUMENT_RUNTIME_PACKAGE_FEED_NAME}`;
}

export function validateDocumentRuntimeManifest(manifest, { label = "document runtime manifest" } = {}) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    throw new Error(`${label} is invalid:\n- root: must be an object`);
  }

  if (manifest.schemaVersion !== DOCUMENT_RUNTIME_SCHEMA_VERSION) {
    push(errors, "schemaVersion", `must be ${DOCUMENT_RUNTIME_SCHEMA_VERSION}`);
  }
  if (manifest.packageId !== DOCUMENT_RUNTIME_PACKAGE_ID) {
    push(errors, "packageId", `must be ${DOCUMENT_RUNTIME_PACKAGE_ID}`);
  }
  if (manifest.runtimeId !== DOCUMENT_RUNTIME_PACKAGE_ID) {
    push(errors, "runtimeId", `must be ${DOCUMENT_RUNTIME_PACKAGE_ID}`);
  }
  requireCalVer(errors, manifest.packageVersion, "packageVersion");
  requireCalVer(errors, manifest.version, "version");
  requireEnum(errors, manifest.platform, "platform", SUPPORTED_PLATFORMS);
  requireEnum(errors, manifest.channel, "channel", CHANNELS);
  requireCalVer(errors, manifest.minimumAppVersion, "minimumAppVersion");
  requireSha256(errors, manifest.manifestSha256, "manifestSha256");
  requireSha256(errors, manifest.pythonPackagesHash, "pythonPackagesHash");
  requireSha256(errors, manifest.nodePackagesHash, "nodePackagesHash");
  requireSha256(errors, manifest.fontsHash, "fontsHash");

  if (!isPlainObject(manifest.tools)) {
    push(errors, "tools", "must be an object");
  } else {
    for (const tool of REQUIRED_TOOLS) {
      requireString(errors, manifest.tools[tool], `tools.${tool}`);
    }
  }

  assertValid(errors, label);
  return manifest;
}

export function validatePackageFeed(feed, { label = "document runtime package feed" } = {}) {
  const errors = [];
  if (!isPlainObject(feed)) {
    throw new Error(`${label} is invalid:\n- root: must be an object`);
  }

  if (feed.schemaVersion !== DOCUMENT_RUNTIME_SCHEMA_VERSION) {
    push(errors, "schemaVersion", `must be ${DOCUMENT_RUNTIME_SCHEMA_VERSION}`);
  }
  if (feed.packageId !== DOCUMENT_RUNTIME_PACKAGE_ID) {
    push(errors, "packageId", `must be ${DOCUMENT_RUNTIME_PACKAGE_ID}`);
  }
  requireString(errors, feed.releaseTag, "releaseTag", {
    pattern: /^v\d{4}\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
    expected: "release tag vYYYY.M.P",
  });
  requireEnum(errors, feed.channel, "channel", CHANNELS);
  requireString(errors, feed.generatedAt, "generatedAt", {
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    expected: "an ISO timestamp",
  });

  if (!Array.isArray(feed.packages) || feed.packages.length === 0) {
    push(errors, "packages", "must be a non-empty array");
  } else {
    const seen = new Set();
    feed.packages.forEach((entry, index) => {
      const path = `packages[${index}]`;
      if (!isPlainObject(entry)) {
        push(errors, path, "must be an object");
        return;
      }

      if (entry.packageId !== DOCUMENT_RUNTIME_PACKAGE_ID) {
        push(errors, `${path}.packageId`, `must be ${DOCUMENT_RUNTIME_PACKAGE_ID}`);
      }
      requireCalVer(errors, entry.packageVersion, `${path}.packageVersion`);
      requireEnum(errors, entry.platform, `${path}.platform`, SUPPORTED_PLATFORMS);
      requireEnum(errors, entry.channel, `${path}.channel`, CHANNELS);
      requireCalVer(errors, entry.minimumAppVersion, `${path}.minimumAppVersion`);
      requireString(errors, entry.artifactName, `${path}.artifactName`);
      requireHttpsUrl(errors, entry.url, `${path}.url`);
      requireString(errors, entry.signature, `${path}.signature`);
      requireSha256(errors, entry.contentSha256, `${path}.contentSha256`);
      requireSha256(errors, entry.manifestSha256, `${path}.manifestSha256`);

      if (typeof entry.sizeBytes !== "number" || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
        push(errors, `${path}.sizeBytes`, "must be a positive safe integer");
      }

      if (entry.platform && entry.packageVersion && entry.artifactName) {
        const expectedName = documentRuntimePackageAssetName({
          platform: entry.platform,
          packageVersion: entry.packageVersion,
        });
        if (entry.artifactName !== expectedName) {
          push(errors, `${path}.artifactName`, `must be ${expectedName}`);
        }
      }

      const key = `${entry.platform}:${entry.channel}`;
      if (seen.has(key)) {
        push(errors, `${path}.platform`, `duplicates package for ${key}`);
      }
      seen.add(key);
    });
  }

  assertValid(errors, label);
  return feed;
}

export function validateDependencyInventory(inventory, { label = "document runtime dependency inventory" } = {}) {
  const errors = [];
  if (!isPlainObject(inventory)) {
    throw new Error(`${label} is invalid:\n- root: must be an object`);
  }
  if (inventory.schemaVersion !== DOCUMENT_RUNTIME_SCHEMA_VERSION) {
    push(errors, "schemaVersion", `must be ${DOCUMENT_RUNTIME_SCHEMA_VERSION}`);
  }
  if (inventory.packageId !== DOCUMENT_RUNTIME_PACKAGE_ID) {
    push(errors, "packageId", `must be ${DOCUMENT_RUNTIME_PACKAGE_ID}`);
  }
  for (const field of ["systemTools", "pythonPackages", "nodePackages", "fonts", "platforms"]) {
    if (!Array.isArray(inventory[field]) || inventory[field].length === 0) {
      push(errors, field, "must be a non-empty array");
    }
  }
  if (Array.isArray(inventory.systemTools)) {
    const toolIds = new Set();
    inventory.systemTools.forEach((tool, index) => {
      const path = `systemTools[${index}]`;
      if (!isPlainObject(tool)) {
        push(errors, path, "must be an object");
        return;
      }
      requireString(errors, tool.id, `${path}.id`);
      requireString(errors, tool.name, `${path}.name`);
      requireString(errors, tool.versionRequirement, `${path}.versionRequirement`);
      if (!Array.isArray(tool.requiredFor) || tool.requiredFor.length === 0) {
        push(errors, `${path}.requiredFor`, "must be a non-empty array");
      }
      if (typeof tool.id === "string" && tool.id) toolIds.add(tool.id);
    });
    for (const tool of REQUIRED_TOOLS) {
      if (!toolIds.has(tool)) {
        push(errors, "systemTools", `must include required tool ${tool}`);
      }
    }
  }
  for (const field of ["pythonPackages", "nodePackages", "fonts", "platforms"]) {
    if (!Array.isArray(inventory[field])) continue;
    inventory[field].forEach((entry, index) => {
      if (typeof entry !== "string" || entry.trim() === "") {
        push(errors, `${field}[${index}]`, "must be a non-empty string");
      }
    });
  }
  assertValid(errors, label);
  return inventory;
}

export function validateLicenseInventory(inventory, { label = "document runtime license inventory" } = {}) {
  const errors = [];
  if (!isPlainObject(inventory)) {
    throw new Error(`${label} is invalid:\n- root: must be an object`);
  }
  if (inventory.schemaVersion !== DOCUMENT_RUNTIME_SCHEMA_VERSION) {
    push(errors, "schemaVersion", `must be ${DOCUMENT_RUNTIME_SCHEMA_VERSION}`);
  }
  if (inventory.packageId !== DOCUMENT_RUNTIME_PACKAGE_ID) {
    push(errors, "packageId", `must be ${DOCUMENT_RUNTIME_PACKAGE_ID}`);
  }
  if (!Array.isArray(inventory.entries) || inventory.entries.length === 0) {
    push(errors, "entries", "must be a non-empty array");
  } else {
    inventory.entries.forEach((entry, index) => {
      const path = `entries[${index}]`;
      if (!isPlainObject(entry)) {
        push(errors, path, "must be an object");
        return;
      }
      requireString(errors, entry.name, `${path}.name`);
      requireString(errors, entry.kind, `${path}.kind`);
      requireString(errors, entry.licenseExpression, `${path}.licenseExpression`);
      requireString(errors, entry.source, `${path}.source`);
      if (typeof entry.reviewRequired !== "boolean") {
        push(errors, `${path}.reviewRequired`, "must be a boolean");
      }
    });
  }
  assertValid(errors, label);
  return inventory;
}
