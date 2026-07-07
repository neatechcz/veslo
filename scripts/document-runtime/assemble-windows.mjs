#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { validateDocumentRuntimeManifest } from "../../packages/document-runtime/src/index.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "../..");

export const WINDOWS_PLATFORM = "windows-native-x64";
export const DEFAULT_SOURCE_MANIFEST_PATH = resolve(
  repoRoot,
  "packages/document-runtime/manifests/sources/windows-native-x64.json",
);
export const DEFAULT_LOCK_PATH = resolve(
  repoRoot,
  "packages/document-runtime/manifests/sources/windows-native-x64.lock.json",
);
export const DEFAULT_CACHE_DIR = resolve(repoRoot, "packages/document-runtime/.cache/windows-native-x64");
export const DEFAULT_TARGET_DIR = resolve(
  repoRoot,
  "packages/desktop/src-tauri/resources/document-runtime/windows-native-x64",
);

const INVENTORY_PATH = resolve(repoRoot, "packages/document-runtime/manifests/dependency-inventory.json");
const TARGET_TEMPLATE_PATH = resolve(repoRoot, "packages/document-runtime/manifests/targets/windows-native-x64.json");
const REQUIRED_SOURCE_IDS = [
  "libreoffice",
  "poppler",
  "pandoc",
  "qpdf",
  "python",
  "node",
  "dejavu-fonts",
  "noto-sans",
];
const REQUIRED_BINARIES = ["soffice", "pandoc", "pdftoppm", "pdftotext", "pdfimages", "qpdf", "python", "node", "weasyprint"];
const SHA256_RE = /^[a-f0-9]{64}$/i;
const FONT_RE = /\.(?:ttf|otf|ttc)$/i;

const SOURCE_TOOL_VERSIONS = {
  soffice: "26.2.4",
  pandoc: "3.10",
  poppler: "v26.02.0-0",
  qpdf: "v12.3.2",
  python: "3.11.15",
  node: "v22.23.1",
};

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

const shortTempParent = () => resolve(process.env.RUNNER_TEMP || tmpdir());

async function createShortTempWorkDir() {
  const parent = shortTempParent();
  await mkdir(parent, { recursive: true });
  return await mkdtemp(join(parent, `vdr-${process.pid.toString(36)}-${Date.now().toString(36)}-`));
}

const writeJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
};

const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const sha256Text = (value) => createHash("sha256").update(value).digest("hex");

const normalizePath = (path) => path.replace(/\\/g, "/");

const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
};

const hashStringList = (values) => {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(String(value));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const listFiles = async (root) => {
  const files = [];
  const walk = async (directory) => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  };
  if (await exists(root)) await walk(root);
  return files;
};

export const hashDirectory = async (root) => {
  const hash = createHash("sha256");
  const files = await listFiles(root);
  for (const file of files) {
    const info = await stat(file);
    hash.update(normalizePath(relative(root, file)));
    hash.update("\0");
    hash.update(String(info.size));
    hash.update("\0");
    hash.update(await sha256File(file));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const hashDirectoryOrList = async (root, fallbackList) => {
  if (await exists(root)) return await hashDirectory(root);
  return hashStringList(fallbackList);
};

const sourceFileName = (source) => {
  const pathName = new URL(source.url).pathname.split("/").pop() || source.id;
  return `${source.id}-${decodeURIComponent(pathName)}`.replace(/[<>:"/\\|?*]/g, "_");
};

const activeSources = (manifest) => manifest.sources.filter((source) => source.kind !== "deferred");

export function validateSourceManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("Windows document runtime source manifest must be an object.");
  if (manifest.schemaVersion !== 1) throw new Error("Windows document runtime source manifest schemaVersion must be 1.");
  if (manifest.packageId !== "veslo-document-runtime") throw new Error("Windows document runtime source manifest packageId is invalid.");
  if (manifest.platform !== WINDOWS_PLATFORM) throw new Error(`Windows document runtime source manifest platform must be ${WINDOWS_PLATFORM}.`);
  if (!Array.isArray(manifest.sources)) throw new Error("Windows document runtime source manifest sources must be an array.");

  const ids = new Set(manifest.sources.map((source) => source.id));
  for (const id of REQUIRED_SOURCE_IDS) {
    if (!ids.has(id)) throw new Error(`Windows document runtime source manifest missing source: ${id}`);
  }

  for (const source of manifest.sources) {
    if (!source.id || typeof source.id !== "string") throw new Error("Windows document runtime source id must be a non-empty string.");
    if (source.kind === "deferred") continue;
    if (!source.version || typeof source.version !== "string") throw new Error(`Source ${source.id} must include a version.`);
    if (!source.url || typeof source.url !== "string" || !source.url.startsWith("https://")) {
      throw new Error(`Source ${source.id} must include an https URL.`);
    }
    if (source.sizeBytes !== null && source.sizeBytes !== undefined) {
      if (!Number.isSafeInteger(source.sizeBytes) || source.sizeBytes <= 0) {
        throw new Error(`Source ${source.id} sizeBytes must be a positive integer or null.`);
      }
    }
  }

  return manifest;
}

const readLock = async (lockPath) => {
  if (!(await exists(lockPath))) {
    return {
      schemaVersion: 1,
      packageId: "veslo-document-runtime",
      platform: WINDOWS_PLATFORM,
      generated: true,
      trustOnFirstUse: true,
      entries: {},
    };
  }
  const lock = await readJson(lockPath);
  if (!lock.entries || typeof lock.entries !== "object") lock.entries = {};
  return lock;
};

export async function verifyDownloadedSource({ source, filePath, lockEntry = null } = {}) {
  const info = await stat(filePath);
  if (source.sizeBytes !== null && source.sizeBytes !== undefined && info.size !== source.sizeBytes) {
    throw new Error(`Source ${source.id} size mismatch: expected ${source.sizeBytes}, got ${info.size}.`);
  }
  if (lockEntry?.sizeBytes && info.size !== lockEntry.sizeBytes) {
    throw new Error(`Source ${source.id} lock size mismatch: expected ${lockEntry.sizeBytes}, got ${info.size}.`);
  }

  const sha256 = await sha256File(filePath);
  if (lockEntry?.sha256 && lockEntry.sha256 !== sha256) {
    throw new Error(`Source ${source.id} sha256 mismatch: expected ${lockEntry.sha256}, got ${sha256}.`);
  }
  return { sha256, sizeBytes: info.size };
}

export async function defaultDownloadFile(source, outputPath) {
  const response = await fetch(source.url, {
    redirect: "follow",
    headers: { "User-Agent": "veslo-document-runtime-assembler" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed for ${source.id}: HTTP ${response.status}`);
  }
  await mkdir(dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  await rm(tempPath, { force: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
  await rename(tempPath, outputPath);
  const contentLength = response.headers.get("content-length");
  return {
    status: response.status,
    contentLength: contentLength ? Number(contentLength) : null,
  };
}

export async function ensureDownloadedSources({
  manifest,
  cacheDir = DEFAULT_CACHE_DIR,
  lockPath = DEFAULT_LOCK_PATH,
  downloader = defaultDownloadFile,
} = {}) {
  validateSourceManifest(manifest);
  await mkdir(cacheDir, { recursive: true });
  const lock = await readLock(lockPath);
  let lockChanged = false;
  const downloads = {};

  for (const source of activeSources(manifest)) {
    const filePath = resolve(cacheDir, sourceFileName(source));
    const existingLockEntry = lock.entries[source.id];
    const lockEntry = existingLockEntry?.url === source.url && existingLockEntry?.version === source.version
      ? existingLockEntry
      : null;

    if (!(await exists(filePath))) {
      await downloader(source, filePath);
    }

    const verified = await verifyDownloadedSource({ source, filePath, lockEntry });
    if (!lockEntry) {
      lock.entries[source.id] = {
        version: source.version,
        url: source.url,
        sizeBytes: verified.sizeBytes,
        sha256: verified.sha256,
        recordedAt: new Date().toISOString(),
      };
      lockChanged = true;
    }
    downloads[source.id] = { ...source, filePath, sha256: verified.sha256, sizeBytes: verified.sizeBytes };
  }

  if (lockChanged) {
    lock.updatedAt = new Date().toISOString();
    await writeJson(lockPath, lock);
  }
  return { downloads, lockPath, lockChanged };
}

export function computeManifestSha256(manifest) {
  return sha256Text(stableJson({ ...manifest, manifestSha256: "" }));
}

export async function buildRuntimeManifest({ targetDir, inventory, targetTemplate } = {}) {
  const pythonSitePackages = resolve(targetDir, "python/venv/Lib/site-packages");
  const pythonFallbackPackages = resolve(targetDir, "python/site-packages");
  const pythonPackagesHash = await hashDirectoryOrList(
    (await exists(pythonSitePackages)) ? pythonSitePackages : pythonFallbackPackages,
    inventory.pythonPackages,
  );
  const nodePackagesHash = await hashDirectoryOrList(resolve(targetDir, "node_modules"), inventory.nodePackages);
  const fontsHash = await hashDirectoryOrList(resolve(targetDir, "fonts"), inventory.fonts);

  const manifest = {
    ...targetTemplate,
    tools: {
      ...targetTemplate.tools,
      ...SOURCE_TOOL_VERSIONS,
    },
    pythonPackagesHash,
    nodePackagesHash,
    fontsHash,
    manifestSha256: "",
  };
  manifest.manifestSha256 = computeManifestSha256(manifest);
  validateDocumentRuntimeManifest(manifest, { label: "assembled Windows document runtime manifest" });
  return manifest;
}

async function runCommand(command, args, { cwd, env = process.env, timeoutMs = 0 } = {}) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0 && !timedOut) {
        resolvePromise({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed${timedOut ? " (timed out)" : ` with code ${code}`}\n${stdout}\n${stderr}`));
    });
  });
}

const sleep = async (delayMs) => {
  if (delayMs > 0) await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
};

export async function runCommandWithRetry(command, args, options = {}, { attempts = 3, delayMs = 3000, runner = runCommand } = {}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1) throw new Error("runCommandWithRetry attempts must be a positive integer.");
  const failures = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await runner(command, args, options);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      if (attempt < attempts) await sleep(delayMs);
    }
  }
  throw new Error([
    `${command} ${args.join(" ")} failed after ${attempts} attempts.`,
    ...failures.map((failure, index) => `attempt ${index + 1}: ${failure}`),
  ].join("\n"));
}

async function resolveTarCommand() {
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const systemTar = join(systemRoot, "System32", "tar.exe");
  return (await exists(systemTar)) ? systemTar : "tar";
}

export async function extractArchive(archivePath, destination, runner = runCommand) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await runner(await resolveTarCommand(), ["-xf", archivePath, "-C", destination], { timeoutMs: 15 * 60 * 1000 });
}

async function collectMatchingFiles(root, predicate, matches = []) {
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectMatchingFiles(path, predicate, matches);
    } else if (entry.isFile() && predicate(path, entry.name)) {
      matches.push(path);
    }
  }
  return matches;
}

const pathDepthFromRoot = (root, filePath) => {
  const path = relative(root, filePath);
  if (!path) return 0;
  return path.split(/[\\/]+/).filter(Boolean).length;
};

async function findFile(root, predicate) {
  const matches = await collectMatchingFiles(root, predicate);
  if (matches.length === 0) return null;
  return matches.reduce((best, candidate) => {
    const bestDepth = pathDepthFromRoot(root, best);
    const candidateDepth = pathDepthFromRoot(root, candidate);
    return candidateDepth < bestDepth ? candidate : best;
  });
}

export async function findFileByName(root, name) {
  const lower = name.toLowerCase();
  return await findFile(root, (_path, entryName) => entryName.toLowerCase() === lower);
}

async function copyFileDirectory(sourceDir, targetDir) {
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      await copyFile(join(sourceDir, entry.name), join(targetDir, entry.name));
    }
  }
}

async function copyNamedFile(root, name, targetDir) {
  const found = await findFileByName(root, name);
  if (!found) throw new Error(`Required file not found after extraction: ${name}`);
  await mkdir(targetDir, { recursive: true });
  await copyFile(found, join(targetDir, name));
  return join(targetDir, name);
}

async function copyFonts(root, targetDir) {
  const files = await listFiles(root);
  const fontFiles = files.filter((path) => FONT_RE.test(path));
  if (fontFiles.length === 0) throw new Error(`No font files found in ${root}`);
  await mkdir(targetDir, { recursive: true });
  for (const fontFile of fontFiles) {
    await copyFile(fontFile, join(targetDir, basename(fontFile)));
  }
  return fontFiles.length;
}

const quoteCmd = (value) => `"${String(value).replace(/"/g, "\"\"")}"`;

async function writeWindowsLauncher(binDir, name, targetRelativeToBin, prefixArgs = []) {
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, `${name}.cmd`);
  const args = prefixArgs.length > 0 ? `${prefixArgs.map(quoteCmd).join(" ")} ` : "";
  await writeFile(path, `@echo off\r\n${quoteCmd(`%~dp0${targetRelativeToBin.replace(/\//g, "\\")}`)} ${args}%*\r\n`, "utf8");
  return path;
}

async function writeDryRunCommand(binDir, name) {
  await mkdir(binDir, { recursive: true });
  await writeFile(join(binDir, `${name}.cmd`), `@echo off\r\necho ${name} dry-run\r\nexit /b 0\r\n`, "utf8");
}

async function assertRequiredLayout(targetDir) {
  const binDir = join(targetDir, "bin");
  for (const command of REQUIRED_BINARIES) {
    const candidates = [join(binDir, `${command}.exe`), join(binDir, `${command}.cmd`), join(binDir, command)];
    if (!(await Promise.any(candidates.map(async (candidate) => {
      if (await exists(candidate)) return true;
      throw new Error(candidate);
    })).catch(() => false))) {
      throw new Error(`Required managed tool missing from assembled runtime: ${command}`);
    }
  }
  for (const directory of ["fonts", "python", "node_modules"]) {
    if (!(await exists(join(targetDir, directory)))) {
      throw new Error(`Required runtime directory missing: ${directory}`);
    }
  }
}

async function readUtf16LogTail(logPath, maxChars = 4000) {
  try {
    const content = await readFile(logPath);
    return content.toString("utf16le").slice(-maxChars).trim();
  } catch {
    return "";
  }
}

export async function runMsiAdministrativeInstall({ msiPath, adminDir, logPath, runner = runCommand } = {}) {
  if (!msiPath) throw new Error("runMsiAdministrativeInstall requires msiPath.");
  if (!adminDir) throw new Error("runMsiAdministrativeInstall requires adminDir.");
  if (!logPath) throw new Error("runMsiAdministrativeInstall requires logPath.");

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await rm(adminDir, { recursive: true, force: true });
    await rm(logPath, { force: true });
    await mkdir(adminDir, { recursive: true });
    try {
      await runner("msiexec.exe", ["/a", msiPath, "/qn", `TARGETDIR=${adminDir}`, "/L*V", logPath], {
        timeoutMs: 30 * 60 * 1000,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === 1) continue;
    }
  }

  const tail = await readUtf16LogTail(logPath);
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error([
    `LibreOffice MSI administrative install failed after retry: ${message}`,
    tail ? `msiexec verbose log tail (${logPath}):\n${tail}` : `msiexec verbose log was not readable: ${logPath}`,
  ].join("\n"));
}

async function installLibreOffice(download, workDir, targetDir, runner) {
  const adminDir = join(workDir, "lo");
  const logPath = join(workDir, "lo-msi.log");
  await runMsiAdministrativeInstall({ msiPath: download.filePath, adminDir, logPath, runner });
  const soffice = await findFileByName(adminDir, "soffice.exe");
  if (!soffice) throw new Error("LibreOffice administrative install did not produce soffice.exe.");
  const programDir = dirname(soffice);
  const libreRoot = basename(programDir).toLowerCase() === "program" ? dirname(programDir) : adminDir;
  const targetLibreRoot = join(targetDir, "libreoffice");
  await cp(libreRoot, targetLibreRoot, { recursive: true, force: true });
  await writeWindowsLauncher(join(targetDir, "bin"), "soffice", normalizePath(join("..", "libreoffice", relative(libreRoot, soffice))));
}

async function installPoppler(download, workDir, targetDir, runner) {
  const extractDir = join(workDir, "poppler");
  await extractArchive(download.filePath, extractDir, runner);
  const pdftoppm = await findFileByName(extractDir, "pdftoppm.exe");
  if (!pdftoppm) throw new Error("Poppler archive did not include pdftoppm.exe.");
  await copyFileDirectory(dirname(pdftoppm), join(targetDir, "bin"));
}

async function installPandoc(download, workDir, targetDir, runner) {
  const extractDir = join(workDir, "pandoc");
  await extractArchive(download.filePath, extractDir, runner);
  await copyNamedFile(extractDir, "pandoc.exe", join(targetDir, "bin"));
}

async function installQpdf(download, workDir, targetDir, runner) {
  const extractDir = join(workDir, "qpdf");
  await extractArchive(download.filePath, extractDir, runner);
  const qpdf = await findFileByName(extractDir, "qpdf.exe");
  if (!qpdf) throw new Error("QPDF archive did not include qpdf.exe.");
  await copyFileDirectory(dirname(qpdf), join(targetDir, "bin"));
}

const replaceLiteral = (text, search, replacement) => search ? text.split(search).join(replacement) : text;

export async function fixVenvPyvenvCfg(venvDir, stagingRoot, targetRoot) {
  const configPath = join(venvDir, "pyvenv.cfg");
  const original = await readFile(configPath, "utf8");
  let updated = replaceLiteral(original, stagingRoot, targetRoot);
  updated = replaceLiteral(updated, stagingRoot.split("\\").join("/"), targetRoot.split("\\").join("/"));
  if (updated.includes(stagingRoot) || updated.includes(stagingRoot.split("\\").join("/"))) {
    throw new Error(`Failed to rewrite staging path in ${configPath}.`);
  }
  if (updated !== original) await writeFile(configPath, updated, "utf8");
}
async function installPython(download, workDir, targetDir, inventory, runner) {
  const extractDir = join(workDir, "python");
  await extractArchive(download.filePath, extractDir, runner);
  const pythonExe = await findFileByName(extractDir, "python.exe");
  if (!pythonExe) throw new Error("Python standalone archive did not include python.exe.");
  const runtimeDir = join(targetDir, "python", "runtime");
  await cp(dirname(pythonExe), runtimeDir, { recursive: true, force: true });
  const runtimePython = join(runtimeDir, "python.exe");
  const venvDir = join(targetDir, "python", "venv");
  await runCommandWithRetry(runtimePython, ["-m", "venv", venvDir], { timeoutMs: 10 * 60 * 1000 }, { runner });
  const venvPython = join(venvDir, "Scripts", "python.exe");
  await runCommandWithRetry(venvPython, ["-m", "ensurepip", "--upgrade"], { timeoutMs: 10 * 60 * 1000 }, { runner });
  await runCommandWithRetry(venvPython, [
    "-m",
    "pip",
    "install",
    "--no-cache-dir",
    "--disable-pip-version-check",
    ...inventory.pythonPackages,
  ], { timeoutMs: 60 * 60 * 1000 }, { runner });
  await mkdir(join(targetDir, "python", "site-packages"), { recursive: true });
  await writeWindowsLauncher(join(targetDir, "bin"), "python", normalizePath(join("..", "python", "venv", "Scripts", "python.exe")));
  await writeWindowsLauncher(join(targetDir, "bin"), "weasyprint", normalizePath(join("..", "python", "venv", "Scripts", "weasyprint.exe")));
}

export async function installNode(download, workDir, targetDir, inventory, runner) {
  const extractDir = join(workDir, "node");
  await extractArchive(download.filePath, extractDir, runner);
  const nodeExe = await findFileByName(extractDir, "node.exe");
  if (!nodeExe) throw new Error("Node.js archive did not include node.exe.");
  const runtimeDir = join(targetDir, "node", "runtime");
  await cp(dirname(nodeExe), runtimeDir, { recursive: true, force: true });
  const runtimeNode = join(runtimeDir, "node.exe");
  const runtimeNpmCli = join(runtimeDir, "node_modules", "npm", "bin", "npm-cli.js");
  try {
    await access(runtimeNpmCli);
  } catch {
    throw new Error("Node.js runtime did not include node_modules/npm/bin/npm-cli.js.");
  }
  await writeWindowsLauncher(join(targetDir, "bin"), "node", normalizePath(join("..", "node", "runtime", "node.exe")));
  await writeWindowsLauncher(join(targetDir, "bin"), "npm", normalizePath(join("..", "node", "runtime", "npm.cmd")));
  const packageJson = {
    private: true,
    name: "veslo-document-runtime-node-modules",
    version: "0.0.0",
    dependencies: Object.fromEntries(inventory.nodePackages.map((name) => [name, "*"])),
  };
  await writeJson(join(targetDir, "package.json"), packageJson);
  await runCommandWithRetry(runtimeNode, [runtimeNpmCli, "install", "--prefix", targetDir, "--omit=dev", "--no-audit", "--no-fund"], {
    timeoutMs: 60 * 60 * 1000,
  }, { runner });
}

async function installFonts(downloads, workDir, targetDir, runner) {
  const dejavuDir = join(workDir, "dejavu-fonts");
  const notoDir = join(workDir, "noto-sans");
  await extractArchive(downloads["dejavu-fonts"].filePath, dejavuDir, runner);
  await extractArchive(downloads["noto-sans"].filePath, notoDir, runner);
  await copyFonts(dejavuDir, join(targetDir, "fonts", "DejaVu"));
  await copyFonts(notoDir, join(targetDir, "fonts", "NotoSans"));
  await mkdir(join(targetDir, "etc", "fonts"), { recursive: true });
  await writeFile(join(targetDir, "etc", "fonts", "fonts.conf"), [
    "<?xml version=\"1.0\"?>",
    "<!DOCTYPE fontconfig SYSTEM \"fonts.dtd\">",
    "<fontconfig>",
    "  <dir>../../fonts</dir>",
    "</fontconfig>",
    "",
  ].join("\n"), "utf8");
}

async function writeManifest(targetDir, inventory, targetTemplate) {
  const manifest = await buildRuntimeManifest({ targetDir, inventory, targetTemplate });
  await writeJson(join(targetDir, "manifest.json"), manifest);
  return manifest;
}

async function createDryRunRuntimeTree(targetDir, inventory, targetTemplate) {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(join(targetDir, "bin"), { recursive: true });
  await mkdir(join(targetDir, "fonts", "DejaVu"), { recursive: true });
  await mkdir(join(targetDir, "fonts", "NotoSans"), { recursive: true });
  await mkdir(join(targetDir, "python", "site-packages"), { recursive: true });
  await mkdir(join(targetDir, "node_modules"), { recursive: true });
  await mkdir(join(targetDir, "tmp"), { recursive: true });
  await mkdir(join(targetDir, "data", "libreoffice-profile"), { recursive: true });
  for (const command of REQUIRED_BINARIES) {
    await writeDryRunCommand(join(targetDir, "bin"), command);
  }
  await writeFile(join(targetDir, "fonts", "DejaVu", "DejaVuSans.ttf"), "dry-run-dejavu\n", "utf8");
  await writeFile(join(targetDir, "fonts", "NotoSans", "NotoSans-Regular.ttf"), "dry-run-noto\n", "utf8");
  await writeFile(join(targetDir, "python", "site-packages", ".dry-run"), inventory.pythonPackages.join("\n"), "utf8");
  await writeFile(join(targetDir, "node_modules", ".dry-run"), inventory.nodePackages.join("\n"), "utf8");
  const manifest = await writeManifest(targetDir, inventory, targetTemplate);
  await assertRequiredLayout(targetDir);
  return manifest;
}

async function createRealRuntimeTree({ targetDir, downloads, inventory, targetTemplate, runner = runCommand }) {
  const stagingDir = `${targetDir}.staging-${process.pid}-${Date.now()}`;
  const workDir = await createShortTempWorkDir();
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  try {
    await mkdir(join(stagingDir, "bin"), { recursive: true });
    await mkdir(join(stagingDir, "tmp"), { recursive: true });
    await mkdir(join(stagingDir, "data", "libreoffice-profile"), { recursive: true });
    await installLibreOffice(downloads.libreoffice, workDir, stagingDir, runner);
    await installPoppler(downloads.poppler, workDir, stagingDir, runner);
    await installPandoc(downloads.pandoc, workDir, stagingDir, runner);
    await installQpdf(downloads.qpdf, workDir, stagingDir, runner);
    await installPython(downloads.python, workDir, stagingDir, inventory, runner);
    await installNode(downloads.node, workDir, stagingDir, inventory, runner);
    await installFonts(downloads, workDir, stagingDir, runner);
    const manifest = await writeManifest(stagingDir, inventory, targetTemplate);
    await assertRequiredLayout(stagingDir);
    await rm(targetDir, { recursive: true, force: true });
    await mkdir(dirname(targetDir), { recursive: true });
    await rename(stagingDir, targetDir);
    await fixVenvPyvenvCfg(join(targetDir, "python", "venv"), stagingDir, targetDir);
    return manifest;
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  }
}

export async function assembleWindowsDocumentRuntime(options = {}) {
  const targetDir = resolve(options.targetDir || DEFAULT_TARGET_DIR);
  const sourceManifestPath = resolve(options.sourceManifestPath || DEFAULT_SOURCE_MANIFEST_PATH);
  const lockPath = resolve(options.lockPath || DEFAULT_LOCK_PATH);
  const cacheDir = resolve(options.cacheDir || DEFAULT_CACHE_DIR);
  const dryRun = Boolean(options.dryRun || options.skipHeavy);
  const sourceManifest = validateSourceManifest(await readJson(sourceManifestPath));
  const inventory = await readJson(INVENTORY_PATH);
  const targetTemplate = await readJson(TARGET_TEMPLATE_PATH);

  if (dryRun) {
    const manifest = await createDryRunRuntimeTree(targetDir, inventory, targetTemplate);
    return {
      ok: true,
      dryRun: true,
      targetDir,
      manifest,
      sources: activeSources(sourceManifest).map((source) => ({ id: source.id, version: source.version, url: source.url })),
    };
  }

  const { downloads, lockChanged } = await ensureDownloadedSources({
    manifest: sourceManifest,
    cacheDir,
    lockPath,
    downloader: options.downloader || defaultDownloadFile,
  });
  const manifest = await createRealRuntimeTree({
    targetDir,
    downloads,
    inventory,
    targetTemplate,
    runner: options.runner || runCommand,
  });

  return {
    ok: true,
    dryRun: false,
    targetDir,
    cacheDir,
    lockPath,
    lockChanged,
    manifest,
    downloads: Object.fromEntries(Object.entries(downloads).map(([id, value]) => [id, {
      version: value.version,
      url: value.url,
      sizeBytes: value.sizeBytes,
      sha256: value.sha256,
    }])),
  };
}

function parseArgs(argv) {
  const options = { dryRun: false, json: false };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run" || arg === "--skip-heavy") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--target-dir") {
      options.targetDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--cache-dir") {
      options.cacheDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--sources") {
      options.sourceManifestPath = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--lock") {
      options.lockPath = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

const maybeRunCli = async () => {
  if (resolve(process.argv[1] || "") !== fileURLToPath(import.meta.url)) return;
  try {
    const options = parseArgs(process.argv);
    const result = await assembleWindowsDocumentRuntime(options);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else if (result.dryRun) {
      process.stdout.write(`Prepared dry-run Windows document runtime tree at ${result.targetDir}\n`);
    } else {
      process.stdout.write(`Assembled Windows document runtime tree at ${result.targetDir}\n`);
      process.stdout.write(`Source lock ${result.lockChanged ? "updated" : "verified"}: ${result.lockPath}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  }
};

await maybeRunCli();