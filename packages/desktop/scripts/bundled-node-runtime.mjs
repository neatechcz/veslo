const APPLE_NODE_ARCH_BY_TARGET = Object.freeze({
  "aarch64-apple-darwin": "arm64",
  "x86_64-apple-darwin": "x64",
});

export const resolveBundledNodeRuntimeDistribution = ({ version, platform, targetTriple }) => {
  const normalizedVersion = String(version ?? "").trim();
  const normalizedPlatform = String(platform ?? "").trim();
  const normalizedTargetTriple = String(targetTriple ?? "").trim();
  const nodeArch =
    normalizedPlatform === "darwin" ? APPLE_NODE_ARCH_BY_TARGET[normalizedTargetTriple] : undefined;

  if (!/^\d+\.\d+\.\d+$/.test(normalizedVersion) || !nodeArch) {
    throw new Error(`Unsupported bundled Node.js target: ${normalizedPlatform}/${normalizedTargetTriple}`);
  }

  const distributionDirectory = `node-v${normalizedVersion}-darwin-${nodeArch}`;
  const archiveName = `${distributionDirectory}.tar.gz`;
  return {
    archiveName,
    distributionDirectory,
    executablePathParts: [distributionDirectory, "bin", "node"],
    shasumsUrl: `https://nodejs.org/dist/v${normalizedVersion}/SHASUMS256.txt`,
    url: `https://nodejs.org/dist/v${normalizedVersion}/${archiveName}`,
  };
};

const checksumForArchive = (shasums, archiveName) => {
  for (const line of String(shasums ?? "").split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match?.[2] === archiveName) return match[1].toLowerCase();
  }
  throw new Error(`Bundled Node.js checksum is missing for ${archiveName}.`);
};

export const verifyBundledNodeArchiveChecksum = ({ archivePath, archiveName, shasums }) => {
  const expected = checksumForArchive(shasums, archiveName);
  const actual = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  if (actual !== expected) {
    throw new Error(`Bundled Node.js archive checksum mismatch for ${archiveName}.`);
  }
};

export const validateBundledNodeArchiveEntries = ({ entries, distributionDirectory }) => {
  const expectedExecutable = `${distributionDirectory}/bin/node`;
  let hasExpectedExecutable = false;
  for (const rawEntry of entries) {
    const entry = String(rawEntry ?? "").trim().replace(/\/$/, "");
    if (!entry) continue;
    const segments = entry.split("/");
    if (isAbsolute(entry) || entry.includes("\\") || segments.includes("..")) {
      throw new Error(`Bundled Node.js archive contains unsafe entry: ${entry}.`);
    }
    if (entry !== distributionDirectory && !entry.startsWith(`${distributionDirectory}/`)) {
      throw new Error(`Bundled Node.js archive contains unexpected entry prefix: ${entry}.`);
    }
    if (entry === expectedExecutable) hasExpectedExecutable = true;
  }
  if (!hasExpectedExecutable) {
    throw new Error(`Bundled Node.js archive is missing ${expectedExecutable}.`);
  }
};

export const publishBundledNodeExecutable = ({ sourcePath, targetPaths }) => {
  const sourceInfo = lstatSync(sourcePath);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error("Bundled Node.js source executable must be a regular file.");
  }

  for (const targetPath of targetPaths) {
    mkdirSync(dirname(targetPath), { recursive: true });
    const temporaryPath = join(
      dirname(targetPath),
      `.${basename(targetPath)}.tmp-${process.pid}-${randomUUID()}`,
    );
    try {
      copyFileSync(sourcePath, temporaryPath);
      chmodSync(temporaryPath, 0o755);
      const temporaryInfo = lstatSync(temporaryPath);
      if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink()) {
        throw new Error("Bundled Node.js published executable must be a regular file.");
      }
      renameSync(temporaryPath, targetPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
};
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
