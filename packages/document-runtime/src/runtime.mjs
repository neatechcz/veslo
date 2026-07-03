import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { constants as fsConstants, createReadStream, createWriteStream } from "node:fs";
import { access, chmod, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { createGunzip, createGzip } from "node:zlib";

import {
  DOCUMENT_RUNTIME_PACKAGE_ID,
  validateDocumentRuntimeManifest,
} from "./manifest.mjs";

const DEFAULT_TIMEOUT_MS = 5000;
const PACKAGE_ARCHIVE_FORMAT = "veslo-document-runtime-package-v1";
const PACKAGE_ARCHIVE_CHUNK_BYTES = 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

const MANAGED_BINARIES = {
  soffice: ["soffice"],
  pandoc: ["pandoc"],
  pdftoppm: ["pdftoppm"],
  pdftotext: ["pdftotext"],
  pdfimages: ["pdfimages"],
  qpdf: ["qpdf"],
  python: ["python", "python3"],
  node: ["node"],
  weasyprint: ["weasyprint"],
  "fc-list": ["fc-list"],
};

export const REQUIRED_MANAGED_COMMANDS = [
  { id: "soffice", command: "soffice", args: ["--headless", "--version"] },
  { id: "pandoc", command: "pandoc", args: ["--version"] },
  { id: "poppler-pdftoppm", command: "pdftoppm", args: ["-v"] },
  { id: "poppler-pdftotext", command: "pdftotext", args: ["-v"] },
  { id: "poppler-pdfimages", command: "pdfimages", args: ["-v"] },
  { id: "qpdf", command: "qpdf", args: ["--version"] },
  { id: "weasyprint", command: "weasyprint", args: ["--version"] },
];

const DOCTOR_TOOL_CHECKS = [
  ...REQUIRED_MANAGED_COMMANDS,
  {
    id: "python-imports",
    command: "python",
    args: [
      "-c",
      [
        "import defusedxml,lxml,openpyxl,pandas,pptx,PIL,six,markitdown,pypdf,pdfplumber,reportlab,pdf2image,pypdfium2,weasyprint",
      ].join(";"),
    ],
  },
  {
    id: "node-modules",
    command: "node",
    args: [
      "-e",
      [
        "for (const name of ['docx','pptxgenjs','react','react-dom','react-icons','pdf-lib','pdfjs-dist'])",
        "{ require.resolve(name); }",
      ].join(" "),
    ],
  },
];

const isWindows = () => process.platform === "win32";

const executableCandidates = (name) => {
  if (!isWindows()) return [name];
  if (/\.(exe|cmd|bat)$/i.test(name)) return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
};

const defaultDataRoot = (env = process.env) => {
  if (env.VESLO_DOCUMENT_RUNTIME_ROOT) return resolve(env.VESLO_DOCUMENT_RUNTIME_ROOT);
  if (process.platform === "win32") {
    const base = env.LOCALAPPDATA || env.APPDATA || join(env.USERPROFILE || env.HOME || ".", "AppData", "Local");
    return resolve(base, "Veslo", "document-runtime");
  }
  if (process.platform === "darwin") {
    return resolve(env.HOME || ".", "Library", "Application Support", "Veslo", "document-runtime");
  }
  const base = env.XDG_DATA_HOME || join(env.HOME || ".", ".local", "share");
  return resolve(base, "Veslo", "document-runtime");
};

const windowsProcessEnv = (env) => {
  if (!isWindows()) return {};
  const preserved = {};
  for (const key of ["SystemRoot", "WINDIR", "windir", "ComSpec", "COMSPEC", "PATHEXT"]) {
    if (env[key]) {
      preserved[key] = env[key];
    } else if (process.env[key]) {
      preserved[key] = process.env[key];
    }
  }
  return preserved;
};

const inside = (base, target) => {
  const rel = relative(resolve(base), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const fileExists = async (path) => {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (path) => {
  const content = await readFile(path, "utf8");
  return JSON.parse(content);
};

const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const writeArchiveLine = async (stream, value) => {
  if (!stream.write(`${JSON.stringify(value)}\n`, "utf8")) {
    await once(stream, "drain");
  }
};

const writeStreamBuffer = async (stream, value) => {
  if (!stream.write(value)) {
    await once(stream, "drain");
  }
};

const endWritable = async (stream) => {
  await new Promise((resolvePromise, reject) => {
    stream.once("error", reject);
    stream.end(resolvePromise);
  });
};

const normalizeArchivePath = (value) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Document runtime archive entry path must be a non-empty string.");
  }
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || isAbsolute(value)) {
    throw new Error(`Document runtime archive entry path is unsafe: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`Document runtime archive entry path is unsafe: ${value}`);
  }
  return parts.join("/");
};

const decodeArchiveChunk = (value) => {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64_RE.test(value)) {
    throw new Error("Document runtime archive chunk is not valid base64.");
  }
  return Buffer.from(value, "base64");
};

const normalizeOutput = (value) => String(value || "").trim().split(/\r?\n/)[0] || undefined;

const quoteWindowsCmdArg = (value) => {
  const text = String(value);
  if (!/[ \t&()^|<>"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
};

const spawnSpec = (commandPath, args, env) => {
  if (isWindows() && /\.(cmd|bat)$/i.test(commandPath)) {
    return {
      command: env.ComSpec || env.COMSPEC || process.env.ComSpec || process.env.COMSPEC || "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/s", "/c", [commandPath, ...args].map(quoteWindowsCmdArg).join(" ")],
    };
  }
  return { command: commandPath, args };
};

export async function resolveActiveRuntime({ env = process.env, runtimeRoot } = {}) {
  const root = resolve(runtimeRoot || defaultDataRoot(env));
  const override = env.VESLO_DOCUMENT_RUNTIME_ACTIVE_DIR;
  if (override) {
    const activePath = resolve(override);
    return {
      ok: true,
      runtimeRoot: root,
      activePath,
      source: "env",
    };
  }

  const pointerPath = join(root, "active.json");
  if (!(await fileExists(pointerPath))) {
    return {
      ok: false,
      status: "missing",
      runtimeRoot: root,
      activePath: "",
      source: "active.json",
      error: `Document runtime active pointer missing: ${pointerPath}`,
    };
  }

  let pointer;
  try {
    pointer = await readJson(pointerPath);
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      runtimeRoot: root,
      activePath: "",
      source: "active.json",
      error: `Unable to read active runtime pointer ${pointerPath}: ${error.message}`,
    };
  }

  const candidate = typeof pointer.activePath === "string" && pointer.activePath
    ? resolve(root, pointer.activePath)
    : resolve(root, String(pointer.version || ""));
  if (!candidate || candidate === root) {
    return {
      ok: false,
      status: "missing",
      runtimeRoot: root,
      activePath: "",
      source: "active.json",
      error: "Document runtime active pointer must include activePath or version.",
    };
  }
  if (!inside(root, candidate)) {
    return {
      ok: false,
      status: "blocked",
      runtimeRoot: root,
      activePath: candidate,
      source: "active.json",
      error: "Document runtime active pointer resolves outside the Veslo runtime root.",
    };
  }

  return {
    ok: true,
    runtimeRoot: root,
    activePath: candidate,
    source: "active.json",
  };
}

export function buildManagedEnv(activePath, { env = process.env } = {}) {
  const binDir = join(activePath, "bin");
  const tmpDir = join(activePath, "tmp");
  const libreOfficeProfile = join(activePath, "data", "libreoffice-profile");
  const pythonPath = [
    join(activePath, "python"),
    join(activePath, "python", "site-packages"),
  ].join(delimiter);
  const nodePath = join(activePath, "node_modules");
  const fontConfigPath = join(activePath, "etc", "fonts");

  return {
    ...windowsProcessEnv(env),
    ...env,
    PATH: binDir,
    Path: binDir,
    PYTHONPATH: pythonPath,
    NODE_PATH: nodePath,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    FONTCONFIG_PATH: fontConfigPath,
    VESLO_DOCUMENT_RUNTIME_ACTIVE_DIR: activePath,
    VESLO_LIBREOFFICE_USER_PROFILE: libreOfficeProfile,
  };
}

export async function resolveManagedCommand(activePath, command) {
  if (!command || command.includes("/") || command.includes("\\") || isAbsolute(command)) {
    throw new Error("Managed runtime command must be a bare command name.");
  }

  const names = MANAGED_BINARIES[command] || [command];
  const candidates = names.flatMap((name) => executableCandidates(name).map((candidate) => join(activePath, "bin", candidate)));
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) return candidate;
    } catch {
      // Continue looking through deterministic managed candidates only.
    }
  }

  throw new Error(`Managed command '${command}' not found in ${join(activePath, "bin")}`);
}

async function runManaged(activePath, command, args, { env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const commandPath = await resolveManagedCommand(activePath, command);
  await mkdir(join(activePath, "tmp"), { recursive: true });
  await mkdir(join(activePath, "data", "libreoffice-profile"), { recursive: true });

  const childEnv = buildManagedEnv(activePath, { env });
  const spec = spawnSpec(commandPath, args, childEnv);

  return await new Promise((resolvePromise) => {
    const child = spawn(spec.command, spec.args, {
      env: childEnv,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, commandPath, stdout, stderr, error: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0 && !timedOut,
        commandPath,
        code,
        stdout,
        stderr,
        error: timedOut ? `Timed out after ${timeoutMs}ms` : code === 0 ? undefined : `Exited with code ${code}`,
        timedOut,
      });
    });
  });
}

async function loadActiveManifest(activePath) {
  const manifestPath = join(activePath, "manifest.json");
  const manifest = await readJson(manifestPath);
  validateDocumentRuntimeManifest(manifest, { label: manifestPath });
  return { manifest, manifestPath };
}

function compareVersionDescending(a, b) {
  const left = String(a || "").split(/[^\d]+/).filter(Boolean).map(Number);
  const right = String(b || "").split(/[^\d]+/).filter(Boolean).map(Number);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (right[index] || 0) - (left[index] || 0);
    if (delta) return delta;
  }
  return String(b || "").localeCompare(String(a || ""));
}

async function listRuntimeDirectories(parent) {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name));
  } catch {
    return [];
  }
}

async function discoverRuntimePackageCandidates(runtimeRoot) {
  const root = resolve(runtimeRoot);
  const directories = [
    ...(await listRuntimeDirectories(root)),
    ...(await listRuntimeDirectories(join(root, "packages"))),
    ...(await listRuntimeDirectories(join(root, "staged"))),
  ];
  const seen = new Set();
  const candidates = [];

  for (const directory of directories) {
    const activePath = resolve(directory);
    if (!inside(root, activePath) || seen.has(activePath)) continue;
    seen.add(activePath);
    try {
      const { manifest } = await loadActiveManifest(activePath);
      candidates.push({ activePath, manifest });
    } catch {
      // Ignore incomplete or invalid staged packages during repair discovery.
    }
  }

  return candidates.sort((a, b) => compareVersionDescending(a.manifest.packageVersion, b.manifest.packageVersion));
}

async function writeActivePointer(runtimeRoot, candidate) {
  const root = resolve(runtimeRoot);
  const activePath = resolve(candidate.activePath);
  if (!inside(root, activePath)) {
    throw new Error("Document runtime repair candidate resolves outside the runtime root.");
  }

  const activePathRelative = relative(root, activePath).replace(/\\/g, "/");
  const pointer = {
    schemaVersion: 1,
    packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
    activePath: activePathRelative,
    version: candidate.manifest.packageVersion,
    runtimeVersion: candidate.manifest.version,
    updatedAt: new Date().toISOString(),
    source: "headless-repair",
  };
  const pointerPath = join(root, "active.json");
  const tempPath = join(root, `active.json.${process.pid}.${Date.now()}.tmp`);
  await mkdir(root, { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  await rename(tempPath, pointerPath);
  return pointer;
}

async function collectArchiveFiles(sourcePath) {
  const sourceRealPath = await realpath(sourcePath);
  const activeDirectories = new Set();
  const directories = [];
  const files = [];

  const walk = async (directory, archivePrefix = "") => {
    const directoryRealPath = await realpath(directory);
    if (!inside(sourceRealPath, directoryRealPath)) {
      throw new Error(`Document runtime package source resolves outside the source root: ${directory}`);
    }
    const directoryKey = process.platform === "win32" ? directoryRealPath.toLowerCase() : directoryRealPath;
    if (activeDirectories.has(directoryKey)) {
      throw new Error(`Document runtime package source contains a directory cycle: ${directory}`);
    }
    activeDirectories.add(directoryKey);

    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryPath = join(directory, entry.name);
      const archivePath = normalizeArchivePath(archivePrefix ? `${archivePrefix}/${entry.name}` : entry.name);
      const entryRealPath = await realpath(entryPath);
      if (!inside(sourceRealPath, entryRealPath)) {
        throw new Error(`Document runtime package entry resolves outside the source root: ${archivePath}`);
      }

      const info = await stat(entryPath);
      if (info.isDirectory()) {
        directories.push({
          archivePath,
          mode: info.mode & 0o777,
        });
        await walk(entryPath, archivePath);
      } else if (info.isFile()) {
        files.push({
          absolutePath: entryPath,
          archivePath,
          mode: info.mode & 0o777,
          sizeBytes: info.size,
        });
      } else {
        throw new Error(`Document runtime package entry must be a file or directory: ${archivePath}`);
      }
    }

    activeDirectories.delete(directoryKey);
  };

  await walk(sourcePath);
  return {
    directories: directories.sort((a, b) => a.archivePath.localeCompare(b.archivePath)),
    files: files.sort((a, b) => a.archivePath.localeCompare(b.archivePath)),
  };
}

export async function doctor({ env = process.env, runtimeRoot, activePath, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const resolved = activePath
    ? { ok: true, runtimeRoot: resolve(runtimeRoot || defaultDataRoot(env)), activePath: resolve(activePath), source: "argument" }
    : await resolveActiveRuntime({ env, runtimeRoot });
  const checks = [];

  if (!resolved.ok) {
    const repairCandidates = await discoverRuntimePackageCandidates(resolved.runtimeRoot);
    checks.push({ id: "active-runtime", ok: false, status: resolved.status || "missing", error: resolved.error });
    return {
      ok: false,
      status: resolved.status || "missing",
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      runtimeRoot: resolved.runtimeRoot,
      activePath: resolved.activePath,
      repairAvailable: repairCandidates.length > 0,
      checks,
    };
  }

  if (!(await fileExists(resolved.activePath))) {
    const repairCandidates = await discoverRuntimePackageCandidates(resolved.runtimeRoot);
    checks.push({ id: "active-runtime", ok: false, status: "missing", error: `Active runtime directory missing: ${resolved.activePath}` });
    return {
      ok: false,
      status: "missing",
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      runtimeRoot: resolved.runtimeRoot,
      activePath: resolved.activePath,
      repairAvailable: repairCandidates.length > 0,
      checks,
    };
  }

  let manifest;
  let manifestPath;
  try {
    const loaded = await loadActiveManifest(resolved.activePath);
    manifest = loaded.manifest;
    manifestPath = loaded.manifestPath;
    checks.push({ id: "manifest", ok: true, path: manifestPath });
  } catch (error) {
    const repairCandidates = await discoverRuntimePackageCandidates(resolved.runtimeRoot);
    checks.push({ id: "manifest", ok: false, error: error.message });
    return {
      ok: false,
      status: "failed",
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      runtimeRoot: resolved.runtimeRoot,
      activePath: resolved.activePath,
      repairAvailable: repairCandidates.some((candidate) => candidate.activePath !== resolved.activePath),
      checks,
    };
  }

  for (const check of DOCTOR_TOOL_CHECKS) {
    try {
      const result = await runManaged(resolved.activePath, check.command, check.args, { env, timeoutMs });
      checks.push({
        id: check.id,
        ok: result.ok,
        path: result.commandPath,
        version: normalizeOutput(result.stdout) || normalizeOutput(result.stderr),
        error: result.error,
      });
    } catch (error) {
      checks.push({ id: check.id, ok: false, error: error.message });
    }
  }

  const fontsPath = join(resolved.activePath, "fonts");
  checks.push({
    id: "fonts",
    ok: await fileExists(fontsPath),
    path: fontsPath,
    error: (await fileExists(fontsPath)) ? undefined : "Managed fonts directory missing.",
  });

  const ok = checks.every((check) => check.ok);
  const repairCandidates = ok
    ? []
    : await discoverRuntimePackageCandidates(resolved.runtimeRoot);
  return {
    ok,
    status: ok ? "ready" : "failed",
    packageId: manifest.packageId,
    packageVersion: manifest.packageVersion,
    runtimeVersion: manifest.version,
    platform: manifest.platform,
    runtimeRoot: resolved.runtimeRoot,
    activePath: resolved.activePath,
    repairAvailable: repairCandidates.some((candidate) => candidate.activePath !== resolved.activePath),
    checks,
  };
}

export async function pathInfo(options = {}) {
  const resolved = await resolveActiveRuntime(options);
  const info = {
    ok: resolved.ok,
    status: resolved.ok ? "ready" : resolved.status || "missing",
    packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
    runtimeRoot: resolved.runtimeRoot,
    activePath: resolved.activePath,
    source: resolved.source,
  };
  if (!resolved.ok) {
    return { ...info, error: resolved.error };
  }
  const managedEnv = buildManagedEnv(resolved.activePath, options);
  return {
    ...info,
    binDir: join(resolved.activePath, "bin"),
    manifestPath: join(resolved.activePath, "manifest.json"),
    tmpDir: managedEnv.TMPDIR,
    nodePath: managedEnv.NODE_PATH,
    pythonPath: managedEnv.PYTHONPATH,
    libreOfficeUserProfile: managedEnv.VESLO_LIBREOFFICE_USER_PROFILE,
    fontConfigPath: managedEnv.FONTCONFIG_PATH,
    env: {
      PATH: managedEnv.PATH,
      PYTHONPATH: managedEnv.PYTHONPATH,
      NODE_PATH: managedEnv.NODE_PATH,
      TMPDIR: managedEnv.TMPDIR,
      FONTCONFIG_PATH: managedEnv.FONTCONFIG_PATH,
      VESLO_LIBREOFFICE_USER_PROFILE: managedEnv.VESLO_LIBREOFFICE_USER_PROFILE,
    },
  };
}

export async function repairHeadless(options = {}) {
  const result = await doctor(options);
  if (result.ok) {
    return {
      ok: true,
      status: "ready",
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      repaired: false,
      reason: "Document runtime package is already ready.",
      doctor: result,
    };
  }

  const env = options.env ?? process.env;
  const runtimeRoot = resolve(options.runtimeRoot || defaultDataRoot(env));
  const candidates = await discoverRuntimePackageCandidates(runtimeRoot);
  for (const candidate of candidates) {
    const candidateDoctor = await doctor({
      ...options,
      env,
      runtimeRoot,
      activePath: candidate.activePath,
    });
    if (!candidateDoctor.ok) continue;
    const pointer = await writeActivePointer(runtimeRoot, candidate);
    const repairedDoctor = await doctor({
      ...options,
      env,
      runtimeRoot,
    });
    return {
      ok: repairedDoctor.ok,
      status: repairedDoctor.ok ? "ready" : repairedDoctor.status,
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      repaired: true,
      reason: `Activated staged document runtime package ${candidate.manifest.packageVersion}.`,
      activePath: candidate.activePath,
      pointer,
      doctor: repairedDoctor.ok ? repairedDoctor : candidateDoctor,
    };
  }

  return {
    ok: result.ok,
    status: result.ok ? "ready" : result.status,
    packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
    repaired: false,
    reason: "No ready staged document runtime package is available for headless repair.",
    doctor: result,
  };
}

export async function stageExpandedPackage({
  sourceDir,
  env = process.env,
  runtimeRoot,
  activate = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!sourceDir || typeof sourceDir !== "string") {
    throw new Error("stageExpandedPackage requires sourceDir.");
  }

  const root = resolve(runtimeRoot || defaultDataRoot(env));
  const sourcePath = resolve(sourceDir);
  const { manifest } = await loadActiveManifest(sourcePath);
  const targetPath = join(root, "packages", manifest.packageVersion);
  if (!inside(root, targetPath)) {
    throw new Error("Document runtime package target resolves outside the runtime root.");
  }

  const existingDoctor = await doctor({ env, runtimeRoot: root, activePath: targetPath, timeoutMs });
  if (existingDoctor.ok) {
    let pointer = null;
    if (activate) {
      pointer = await writeActivePointer(root, { activePath: targetPath, manifest });
    }
    return {
      ok: true,
      status: "ready",
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      packageVersion: manifest.packageVersion,
      staged: false,
      activated: Boolean(activate),
      activePath: targetPath,
      pointer,
      doctor: activate ? await doctor({ env, runtimeRoot: root, timeoutMs }) : existingDoctor,
      reason: "Document runtime package is already staged.",
    };
  }

  const tempPath = join(root, ".staging", `${manifest.packageVersion}-${process.pid}-${Date.now()}`);
  await rm(tempPath, { recursive: true, force: true });
  await mkdir(dirname(tempPath), { recursive: true });
  await cp(sourcePath, tempPath, { recursive: true, force: false, errorOnExist: true });

  const stagedDoctor = await doctor({ env, runtimeRoot: root, activePath: tempPath, timeoutMs });
  if (!stagedDoctor.ok) {
    await rm(tempPath, { recursive: true, force: true });
    return {
      ok: false,
      status: stagedDoctor.status,
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      packageVersion: manifest.packageVersion,
      staged: false,
      activated: false,
      activePath: tempPath,
      reason: "Document runtime staged package failed doctor checks.",
      doctor: stagedDoctor,
    };
  }

  await mkdir(dirname(targetPath), { recursive: true });
  await rm(targetPath, { recursive: true, force: true });
  await rename(tempPath, targetPath);

  let pointer = null;
  if (activate) {
    pointer = await writeActivePointer(root, { activePath: targetPath, manifest });
  }

  return {
    ok: true,
    status: "ready",
    packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
    packageVersion: manifest.packageVersion,
    staged: true,
    activated: Boolean(activate),
    activePath: targetPath,
    pointer,
    doctor: activate
      ? await doctor({ env, runtimeRoot: root, timeoutMs })
      : await doctor({ env, runtimeRoot: root, activePath: targetPath, timeoutMs }),
    reason: activate
      ? `Staged and activated document runtime package ${manifest.packageVersion}.`
      : `Staged document runtime package ${manifest.packageVersion}.`,
  };
}

export async function packExpandedPackage({
  sourceDir,
  outputPath,
} = {}) {
  if (!sourceDir || typeof sourceDir !== "string") {
    throw new Error("packExpandedPackage requires sourceDir.");
  }
  if (!outputPath || typeof outputPath !== "string") {
    throw new Error("packExpandedPackage requires outputPath.");
  }

  const sourcePath = resolve(sourceDir);
  const output = resolve(outputPath);
  if (inside(sourcePath, output)) {
    throw new Error("Document runtime package output must not be written inside the package source directory.");
  }

  const { manifest } = await loadActiveManifest(sourcePath);
  const { directories, files } = await collectArchiveFiles(sourcePath);
  if (!files.some((file) => file.archivePath === "manifest.json")) {
    throw new Error("Document runtime package source must include manifest.json.");
  }

  await mkdir(dirname(output), { recursive: true });
  const archiveStream = createGzip();
  const writeStream = createWriteStream(output, { flags: "wx" });
  const archiveDone = pipeline(archiveStream, writeStream);

  let fileCount = 0;
  try {
    await writeArchiveLine(archiveStream, {
      schemaVersion: 1,
      type: "header",
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      archiveFormat: PACKAGE_ARCHIVE_FORMAT,
      packageVersion: manifest.packageVersion,
      runtimeVersion: manifest.version,
      platform: manifest.platform,
      createdAt: new Date().toISOString(),
    });

    for (const directory of directories) {
      await writeArchiveLine(archiveStream, {
        type: "directory",
        path: directory.archivePath,
        mode: directory.mode,
      });
    }

    for (const file of files) {
      await writeArchiveLine(archiveStream, {
        type: "file",
        path: file.archivePath,
        mode: file.mode,
        sizeBytes: file.sizeBytes,
      });

      const hash = createHash("sha256");
      let sizeBytes = 0;
      for await (const chunk of createReadStream(file.absolutePath, { highWaterMark: PACKAGE_ARCHIVE_CHUNK_BYTES })) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        await writeArchiveLine(archiveStream, {
          type: "chunk",
          contentBase64: chunk.toString("base64"),
        });
      }

      await writeArchiveLine(archiveStream, {
        type: "endFile",
        path: file.archivePath,
        sha256: hash.digest("hex"),
        sizeBytes,
      });
      fileCount += 1;
    }

    await writeArchiveLine(archiveStream, {
      type: "endArchive",
      directoryCount: directories.length,
      fileCount,
    });
    archiveStream.end();
    await archiveDone;
  } catch (error) {
    archiveStream.destroy();
    writeStream.destroy();
    await rm(output, { force: true });
    throw error;
  }

  const outputInfo = await stat(output);
  return {
    ok: true,
    status: "packed",
    packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
    packageVersion: manifest.packageVersion,
    runtimeVersion: manifest.version,
    platform: manifest.platform,
    artifactPath: output,
    directoryCount: directories.length,
    fileCount,
    sizeBytes: outputInfo.size,
    contentSha256: await sha256File(output),
  };
}

export async function installPackageArchive({
  packagePath,
  expectedSha256,
  env = process.env,
  runtimeRoot,
  activate = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!packagePath || typeof packagePath !== "string") {
    throw new Error("installPackageArchive requires packagePath.");
  }
  if (expectedSha256 && !SHA256_RE.test(expectedSha256)) {
    throw new Error("installPackageArchive expectedSha256 must be a 64-character sha256 hex digest.");
  }

  const artifactPath = resolve(packagePath);
  const artifactSha256 = await sha256File(artifactPath);
  if (expectedSha256 && artifactSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    return {
      ok: false,
      status: "failed",
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      installed: false,
      activated: false,
      artifactPath,
      artifactSha256,
      reason: "Document runtime package sha256 mismatch.",
    };
  }

  const root = resolve(runtimeRoot || defaultDataRoot(env));
  const extractRoot = join(root, ".archives", `${process.pid}-${Date.now()}`);
  let currentFile = null;
  let sawHeader = false;
  let sawEndArchive = false;
  let directoryCount = 0;
  let fileCount = 0;

  const fail = async (error) => {
    if (currentFile?.stream) {
      currentFile.stream.destroy();
      currentFile = null;
    }
    await rm(extractRoot, { recursive: true, force: true });
    return {
      ok: false,
      status: "failed",
      packageId: DOCUMENT_RUNTIME_PACKAGE_ID,
      installed: false,
      activated: false,
      artifactPath,
      artifactSha256,
      reason: error instanceof Error ? error.message : String(error),
    };
  };

  try {
    await rm(extractRoot, { recursive: true, force: true });
    await mkdir(extractRoot, { recursive: true });

    const input = createReadStream(artifactPath).pipe(createGunzip());
    const lines = createInterface({ input, crlfDelay: Infinity });

    const closeCurrentFile = async (entry) => {
      if (!currentFile) {
        throw new Error("Document runtime archive endFile entry has no open file.");
      }
      if (entry.path && normalizeArchivePath(entry.path) !== currentFile.archivePath) {
        throw new Error(`Document runtime archive endFile path mismatch: ${entry.path}`);
      }
      if (!SHA256_RE.test(String(entry.sha256 || ""))) {
        throw new Error(`Document runtime archive file ${currentFile.archivePath} has invalid sha256.`);
      }
      await endWritable(currentFile.stream);
      const actualSha256 = currentFile.hash.digest("hex");
      if (actualSha256 !== String(entry.sha256).toLowerCase()) {
        throw new Error(`Document runtime archive file ${currentFile.archivePath} sha256 mismatch.`);
      }
      if (currentFile.sizeBytes !== currentFile.declaredSizeBytes) {
        throw new Error(`Document runtime archive file ${currentFile.archivePath} declared size mismatch.`);
      }
      if (entry.sizeBytes !== currentFile.sizeBytes) {
        throw new Error(`Document runtime archive file ${currentFile.archivePath} size mismatch.`);
      }
      if (currentFile.mode) {
        await chmod(currentFile.targetPath, currentFile.mode);
      }
      currentFile = null;
      fileCount += 1;
    };

    for await (const line of lines) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line);
      if (!sawHeader) {
        if (
          entry.type !== "header"
          || entry.schemaVersion !== 1
          || entry.packageId !== DOCUMENT_RUNTIME_PACKAGE_ID
          || entry.archiveFormat !== PACKAGE_ARCHIVE_FORMAT
        ) {
          throw new Error("Document runtime archive header is invalid.");
        }
        sawHeader = true;
        continue;
      }

      if (entry.type === "directory") {
        if (currentFile) {
          throw new Error("Document runtime archive directory entry appeared before closing the current file.");
        }
        const archivePath = normalizeArchivePath(entry.path);
        const targetPath = join(extractRoot, ...archivePath.split("/"));
        if (!inside(extractRoot, targetPath)) {
          throw new Error(`Document runtime archive directory path is unsafe: ${archivePath}`);
        }
        await mkdir(targetPath, { recursive: true });
        if (typeof entry.mode === "number") {
          await chmod(targetPath, entry.mode & 0o777);
        }
        directoryCount += 1;
        continue;
      }

      if (entry.type === "file") {
        if (currentFile) {
          throw new Error("Document runtime archive started a file before closing the previous file.");
        }
        const archivePath = normalizeArchivePath(entry.path);
        if (typeof entry.sizeBytes !== "number" || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
          throw new Error(`Document runtime archive file ${archivePath} has invalid sizeBytes.`);
        }
        const targetPath = join(extractRoot, ...archivePath.split("/"));
        if (!inside(extractRoot, targetPath)) {
          throw new Error(`Document runtime archive file path is unsafe: ${archivePath}`);
        }
        await mkdir(dirname(targetPath), { recursive: true });
        currentFile = {
          archivePath,
          targetPath,
          mode: typeof entry.mode === "number" ? entry.mode & 0o777 : 0o644,
          declaredSizeBytes: entry.sizeBytes,
          sizeBytes: 0,
          hash: createHash("sha256"),
          stream: createWriteStream(targetPath, { flags: "wx" }),
        };
        continue;
      }

      if (entry.type === "chunk") {
        if (!currentFile) {
          throw new Error("Document runtime archive chunk entry has no open file.");
        }
        const chunk = decodeArchiveChunk(entry.contentBase64);
        currentFile.hash.update(chunk);
        currentFile.sizeBytes += chunk.length;
        if (currentFile.sizeBytes > currentFile.declaredSizeBytes) {
          throw new Error(`Document runtime archive file ${currentFile.archivePath} is larger than declared.`);
        }
        await writeStreamBuffer(currentFile.stream, chunk);
        continue;
      }

      if (entry.type === "endFile") {
        await closeCurrentFile(entry);
        continue;
      }

      if (entry.type === "endArchive") {
        if (currentFile) {
          throw new Error("Document runtime archive ended with an open file.");
        }
        if (entry.directoryCount !== directoryCount) {
          throw new Error("Document runtime archive directory count mismatch.");
        }
        if (entry.fileCount !== fileCount) {
          throw new Error("Document runtime archive file count mismatch.");
        }
        sawEndArchive = true;
        break;
      }

      throw new Error(`Document runtime archive entry type is unsupported: ${entry.type || "(missing)"}`);
    }

    if (!sawHeader) {
      throw new Error("Document runtime archive is empty.");
    }
    if (!sawEndArchive) {
      throw new Error("Document runtime archive did not finish cleanly.");
    }

    const staged = await stageExpandedPackage({
      sourceDir: extractRoot,
      env,
      runtimeRoot: root,
      activate,
      timeoutMs,
    });
    await rm(extractRoot, { recursive: true, force: true });

    return {
      ...staged,
      installed: staged.ok,
      artifactPath,
      artifactSha256,
      directoryCount,
      fileCount,
    };
  } catch (error) {
    return await fail(error);
  }
}

export async function execManaged(argv, { env = process.env, runtimeRoot } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("Usage: veslo-document-runtime exec -- <command> [...args]");
  }
  const resolved = await resolveActiveRuntime({ env, runtimeRoot });
  if (!resolved.ok) {
    throw new Error(resolved.error || "Document runtime package is not active.");
  }
  const [command, ...args] = argv;
  const commandPath = await resolveManagedCommand(resolved.activePath, command);
  const childEnv = buildManagedEnv(resolved.activePath, { env });
  const spec = spawnSpec(commandPath, args, childEnv);
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(spec.command, spec.args, {
      env: childEnv,
      windowsHide: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => resolvePromise(code ?? 1));
  });
}

export function runtimeFileUrl(path) {
  return pathToFileURL(path).toString();
}
