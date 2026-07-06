import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createRequire } from "module";
import { dirname, join, relative, resolve } from "path";
import { tmpdir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const readArg = (name) => {
  const raw = process.argv.slice(2);
  const direct = raw.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.split("=")[1];
  const index = raw.indexOf(name);
  if (index >= 0 && raw[index + 1]) return raw[index + 1];
  return null;
};

const hasFlag = (name) => process.argv.slice(2).includes(name);
const forceBuild = hasFlag("--force") || process.env.VESLO_SIDECAR_FORCE_BUILD === "1";
const sidecarOverride = process.env.VESLO_SIDECAR_DIR?.trim() || readArg("--outdir");
const sidecarDir = sidecarOverride ? resolve(sidecarOverride) : join(__dirname, "..", "src-tauri", "sidecars");
const packageJsonPath = resolve(__dirname, "..", "package.json");
const hiddenPowerShellArgs = (script) => [
  "-NoProfile",
  "-NonInteractive",
  "-WindowStyle",
  "Hidden",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  script,
];

const opencodeGithubRepo = (() => {
  const raw =
    process.env.OPENCODE_GITHUB_REPO?.trim() ||
    process.env.VESLO_OPENCODE_GITHUB_REPO?.trim() ||
    "anomalyco/opencode";
  const normalized = raw
    .replace(/^https:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    return "anomalyco/opencode";
  }
  return normalized;
})();
const opencodeVersion = (() => {
  if (process.env.OPENCODE_VERSION?.trim()) return process.env.OPENCODE_VERSION.trim();
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw);
    if (pkg.opencodeVersion) return String(pkg.opencodeVersion).trim();
  } catch {
    // ignore
  }
  return null;
})();

const normalizeVersion = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.toLowerCase() === "latest") return null;
  return raw.startsWith("v") ? raw.slice(1) : raw;
};

const fetchLatestOpencodeVersion = async () => {
  // Use GitHub API (no auth required). If this fails, the caller can fall back
  // to an explicitly configured version via OPENCODE_VERSION.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`https://api.github.com/repos/${opencodeGithubRepo}/releases/latest`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    const tagName = typeof data?.tag_name === "string" ? data.tag_name : "";
    return normalizeVersion(tagName);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
};
const opencodeAssetOverride = process.env.OPENCODE_ASSET?.trim() || null;
const opencodeRouterVersion = (() => {
  if (process.env.OPENCODE_ROUTER_VERSION?.trim()) return process.env.OPENCODE_ROUTER_VERSION.trim();
  try {
    const raw = readFileSync(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw);
    if (pkg.opencodeRouterVersion) return String(pkg.opencodeRouterVersion).trim();
  } catch {
    // ignore
  }
  return null;
})();
const chromeDevtoolsMcpVersion =
  process.env.CHROME_DEVTOOLS_MCP_VERSION?.trim() ||
  process.env.VESLO_CHROME_DEVTOOLS_MCP_VERSION?.trim() ||
  "0.17.0";

// Target triple for native platform binaries
const resolvedTargetTriple = (() => {
  const envTarget =
    process.env.TAURI_ENV_TARGET_TRIPLE ??
    process.env.CARGO_CFG_TARGET_TRIPLE ??
    process.env.TARGET;
  if (envTarget) return envTarget;
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  }
  if (process.platform === "linux") {
    return process.arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
  }
  if (process.platform === "win32") {
    return process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  }
  return null;
})();

const bunTarget = (() => {
  switch (resolvedTargetTriple) {
    case "aarch64-apple-darwin":
      return "bun-darwin-arm64";
    case "x86_64-apple-darwin":
      return "bun-darwin-x64-baseline";
    case "aarch64-unknown-linux-gnu":
      return "bun-linux-arm64";
    case "x86_64-unknown-linux-gnu":
      return "bun-linux-x64-baseline";
    case "x86_64-pc-windows-msvc":
      return "bun-windows-x64-baseline";
    default:
      return null;
  }
})();

const vesloCodeBaseName = process.platform === "win32" ? "veslo-code.exe" : "veslo-code";
const vesloCodePath = join(sidecarDir, vesloCodeBaseName);
const vesloCodeTargetName = resolvedTargetTriple
  ? `veslo-code-${resolvedTargetTriple}${process.platform === "win32" ? ".exe" : ""}`
  : null;
const vesloCodeTargetPath = vesloCodeTargetName ? join(sidecarDir, vesloCodeTargetName) : null;

const vesloCodeCandidatePath = vesloCodeTargetPath ?? vesloCodePath;
let existingOpencodeVersion = null;

// veslo-server paths
const vesloServerBaseName = "veslo-server";
const vesloServerName = process.platform === "win32" ? `${vesloServerBaseName}.exe` : vesloServerBaseName;
const vesloServerPath = join(sidecarDir, vesloServerName);
const vesloServerBuildName = bunTarget
  ? `${vesloServerBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : vesloServerName;
const vesloServerBuildPath = join(sidecarDir, vesloServerBuildName);
const vesloServerTargetTriple = resolvedTargetTriple;
const vesloServerTargetName = vesloServerTargetTriple
  ? `${vesloServerBaseName}-${vesloServerTargetTriple}${vesloServerTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const vesloServerTargetPath = vesloServerTargetName ? join(sidecarDir, vesloServerTargetName) : null;

const vesloServerDir = resolve(__dirname, "..", "..", "server");

const resolveBuildScript = (dir) => {
  const scriptPath = resolve(dir, "script", "build.ts");
  if (existsSync(scriptPath)) return scriptPath;
  const scriptsPath = resolve(dir, "scripts", "build.ts");
  if (existsSync(scriptsPath)) return scriptsPath;
  return scriptPath;
};

// veslo-code-router paths
const vesloCodeRouterBaseName = "veslo-code-router";
const vesloCodeRouterName = process.platform === "win32" ? `${vesloCodeRouterBaseName}.exe` : vesloCodeRouterBaseName;
const vesloCodeRouterPath = join(sidecarDir, vesloCodeRouterName);
const vesloCodeRouterBuildName = bunTarget
  ? `${vesloCodeRouterBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : vesloCodeRouterName;
const vesloCodeRouterBuildPath = join(sidecarDir, vesloCodeRouterBuildName);
const vesloCodeRouterTargetTriple = resolvedTargetTriple;
const vesloCodeRouterTargetName = vesloCodeRouterTargetTriple
  ? `${vesloCodeRouterBaseName}-${vesloCodeRouterTargetTriple}${vesloCodeRouterTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const vesloCodeRouterTargetPath = vesloCodeRouterTargetName ? join(sidecarDir, vesloCodeRouterTargetName) : null;
const opencodeRouterDir = resolve(__dirname, "..", "..", "opencode-router");

// orchestrator paths
const orchestratorBaseName = "veslo-orchestrator";
const orchestratorName =
  process.platform === "win32" ? `${orchestratorBaseName}.exe` : orchestratorBaseName;
const orchestratorPath = join(sidecarDir, orchestratorName);
const orchestratorBuildName = bunTarget
  ? `${orchestratorBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : orchestratorName;
const orchestratorBuildPath = join(sidecarDir, orchestratorBuildName);
const orchestratorTargetTriple = resolvedTargetTriple;
const orchestratorTargetName = orchestratorTargetTriple
  ? `${orchestratorBaseName}-${orchestratorTargetTriple}${orchestratorTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const orchestratorTargetPath = orchestratorTargetName ? join(sidecarDir, orchestratorTargetName) : null;
const orchestratorDir = resolve(__dirname, "..", "..", "orchestrator");

// chrome-devtools-mcp shim sidecar
const chromeDevtoolsBaseName = "chrome-devtools-mcp";
const chromeDevtoolsName = process.platform === "win32" ? `${chromeDevtoolsBaseName}.exe` : chromeDevtoolsBaseName;
const chromeDevtoolsPath = join(sidecarDir, chromeDevtoolsName);
const chromeDevtoolsBuildName = bunTarget
  ? `${chromeDevtoolsBaseName}-${bunTarget}${bunTarget.includes("windows") ? ".exe" : ""}`
  : chromeDevtoolsName;
const chromeDevtoolsBuildPath = join(sidecarDir, chromeDevtoolsBuildName);
const chromeDevtoolsTargetTriple = resolvedTargetTriple;
const chromeDevtoolsTargetName = chromeDevtoolsTargetTriple
  ? `${chromeDevtoolsBaseName}-${chromeDevtoolsTargetTriple}${chromeDevtoolsTargetTriple.includes("windows") ? ".exe" : ""}`
  : null;
const chromeDevtoolsTargetPath = chromeDevtoolsTargetName ? join(sidecarDir, chromeDevtoolsTargetName) : null;
const chromeDevtoolsShimPath = resolve(__dirname, "chrome-devtools-mcp-shim.ts");

const managedDepsManifestBaseName = "opencode-managed-deps.json";
const managedDepsManifestPath = join(sidecarDir, managedDepsManifestBaseName);
const managedDepsManifestTargetPath = resolvedTargetTriple
  ? join(sidecarDir, `${managedDepsManifestBaseName}-${resolvedTargetTriple}${process.platform === "win32" ? ".exe" : ""}`)
  : null;

const readHeader = (filePath, length = 256) => {
  const fd = openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const isStubBinary = (filePath) => {
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) return true;
    if (stat.size < 1024) return true;
    const header = readHeader(filePath);
    if (header.startsWith("#!")) return true;
    if (header.includes("Sidecar missing") || header.includes("Bun is required")) return true;
  } catch {
    return true;
  }
  return false;
};

const readDirectory = (dir) => {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries.flatMap((entry) => {
    const next = join(dir, entry.name);
    if (entry.isDirectory()) {
      return readDirectory(next);
    }
    if (entry.isFile()) {
      return [next];
    }
    return [];
  });
};

const findOpencodeBinary = (dir) => {
  const candidates = readDirectory(dir);
  // The upstream OpenCode binary is named "opencode" inside the release archive.
  return (
    candidates.find((file) => file.endsWith("/opencode") || file.endsWith("\\opencode")) ??
    candidates.find((file) => file.endsWith("/opencode.exe") || file.endsWith("\\opencode.exe")) ??
    null
  );
};

const findVesloCodeRouterBinary = (dir) => {
  const candidates = readDirectory(dir);
  return (
    candidates.find((file) => file.endsWith(`/${vesloCodeRouterName}`) || file.endsWith(`\\${vesloCodeRouterName}`)) ??
    candidates.find((file) => file.endsWith("/veslo-code-router") || file.endsWith("\\veslo-code-router")) ??
    null
  );
};

const findBunBinary = (dir) => {
  const candidates = readDirectory(dir);
  return candidates.find((file) => file.endsWith("/bun.exe") || file.endsWith("\\bun.exe")) ?? null;
};

const readBinaryVersion = (filePath) => {
  try {
    const result = spawnSync(filePath, ["--version"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
  } catch {
    // ignore
  }
  return null;
};

const sidecarVersionMatches = (filePath, expectedVersion) => {
  if (!expectedVersion) return false;
  if (!existsSync(filePath) || isStubBinary(filePath)) return false;
  return readBinaryVersion(filePath) === expectedVersion;
};

const shouldBuildVersionedSidecar = (filePath, expectedVersion) =>
  forceBuild || !sidecarVersionMatches(filePath, expectedVersion);

const shouldCopyVersionedSidecar = (filePath, expectedVersion, didBuild) =>
  didBuild || !sidecarVersionMatches(filePath, expectedVersion);

const currentBunVersion = () => {
  const result = spawnSync("bun", ["--version"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return null;
};

const ensureWindowsBaselineBunExecutable = () => {
  if (process.platform !== "win32" || bunTarget !== "bun-windows-x64-baseline") {
    return null;
  }

  const override = process.env.BUN_WINDOWS_X64_BASELINE_EXECUTABLE?.trim();
  if (override && existsSync(override)) {
    return override;
  }

  const version = process.env.BUN_VERSION?.trim() || currentBunVersion();
  if (!version) {
    console.error("Unable to resolve Bun version for Windows baseline compile runtime.");
    process.exit(1);
  }

  const targetDir = join(tmpdir(), `veslo-bun-windows-x64-baseline-${version}`);
  const existing = findBunBinary(targetDir);
  if (existing) {
    return existing;
  }

  mkdirSync(targetDir, { recursive: true });
  const archivePath = join(tmpdir(), `bun-windows-x64-baseline-${version}.zip`);
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${version}/bun-windows-x64-baseline.zip`;
  const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
  const psScript = [
    "$ErrorActionPreference = 'Stop'",
    `Invoke-WebRequest -Uri ${psQuote(url)} -OutFile ${psQuote(archivePath)}`,
    `Expand-Archive -Path ${psQuote(archivePath)} -DestinationPath ${psQuote(targetDir)} -Force`,
  ].join("; ");

  const result = spawnSync("powershell", hiddenPowerShellArgs(psScript), {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  const executable = findBunBinary(targetDir);
  if (!executable) {
    console.error(`Bun Windows baseline executable not found after extracting ${archivePath}.`);
    process.exit(1);
  }
  return executable;
};

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
};

const readJsonFile = (filePath) => JSON.parse(readFileSync(filePath, "utf8"));

const packagePathParts = (name) => name.split("/").filter(Boolean);

const packageTargetPath = (name) => packagePathParts(name).join("/");

const packageRelativePath = (root, filePath) => relative(root, filePath).replace(/\\/g, "/");

const readPackageFilesForManifest = (packageRoot) => {
  const files = readDirectory(packageRoot)
    .map((filePath) => ({
      path: packageRelativePath(packageRoot, filePath),
      contentBase64: readFileSync(filePath).toString("base64"),
    }))
    .filter((file) => file.path && !file.path.startsWith("../") && file.path !== "..")
    .sort((a, b) => a.path.localeCompare(b.path));

  if (!files.some((file) => file.path === "package.json")) {
    throw new Error(`Managed dependency package is missing package.json: ${packageRoot}`);
  }

  return files;
};

const findPackageJsonForResolvedEntry = (entryPath) => {
  let current = statSync(entryPath).isDirectory() ? entryPath : dirname(entryPath);
  while (true) {
    const candidate = join(current, "package.json");
    if (existsSync(candidate)) return candidate;
    const next = dirname(current);
    if (next === current) return null;
    current = next;
  }
};

const findPackageRootInAncestorNodeModules = (fromRoot, packageName) => {
  const parts = packagePathParts(packageName);
  let current = fromRoot;
  while (true) {
    const candidate = join(current, "node_modules", ...parts);
    const packageJson = join(candidate, "package.json");
    if (existsSync(packageJson)) return realpathSync(candidate);
    const next = dirname(current);
    if (next === current) return null;
    current = next;
  }
};

const resolvePackageRootFrom = (fromRoot, packageName) => {
  const ancestor = findPackageRootInAncestorNodeModules(fromRoot, packageName);
  if (ancestor) return ancestor;

  const packageJsonPath = join(fromRoot, "package.json");
  const req = createRequire(existsSync(packageJsonPath) ? packageJsonPath : join(fromRoot, "__veslo_resolve__.js"));
  try {
    const entry = req.resolve(packageName);
    const resolvedPackageJson = findPackageJsonForResolvedEntry(entry);
    if (resolvedPackageJson) return realpathSync(dirname(resolvedPackageJson));
  } catch {
    // Some packages intentionally export neither package.json nor a main entry.
  }

  return null;
};

const readManifestPackageJson = (packageRoot) => readJsonFile(resolve(packageRoot, "package.json"));

const dependencyEntriesForPackage = (packageJson) => [
  ...Object.entries(packageJson.dependencies ?? {}).map(([name, range]) => ({
    name,
    range: String(range ?? "").trim(),
    optional: false,
  })),
  ...Object.entries(packageJson.optionalDependencies ?? {}).map(([name, range]) => ({
    name,
    range: String(range ?? "").trim(),
    optional: true,
  })),
];

const collectManagedDependencyGraph = (rootSpecs) => {
  const topLevelVersions = new Map(rootSpecs.map((spec) => [spec.name, spec.version]));
  const entries = new Map();

  const collect = ({ name, version, target, fromRoot, optional = false }) => {
    const packageRoot = resolvePackageRootFrom(fromRoot, name);
    if (!packageRoot) {
      if (optional) return;
      throw new Error(`Managed dependency package root not found: ${name}@${version} from ${fromRoot}`);
    }
    const packageJson = readManifestPackageJson(packageRoot);
    const actualVersion = String(packageJson.version ?? "").trim();
    if (version && actualVersion !== version) {
      throw new Error(`Managed dependency ${name} expected ${version}, found ${actualVersion || "(missing)"}`);
    }
    if (!actualVersion) {
      throw new Error(`Managed dependency ${name} is missing package.json version at ${packageRoot}`);
    }

    const key = target.toLowerCase();
    if (entries.has(key)) return;
    entries.set(key, {
      name,
      version: actualVersion,
      target,
      packageRoot,
    });

    // Veslo managed tools import only @opencode-ai/plugin's public tool helper,
    // whose runtime dependency is zod. Expanding the package's optional effect
    // plugin graph makes the sidecar manifest large and reintroduces slow first-run installs.
    if (version && name === "@opencode-ai/plugin") return;

    for (const dependency of dependencyEntriesForPackage(packageJson)) {
      const dependencyRoot = resolvePackageRootFrom(packageRoot, dependency.name);
      if (!dependencyRoot) {
        if (dependency.optional) continue;
        throw new Error(
          `Managed dependency ${name}@${actualVersion} requires ${dependency.name}@${dependency.range || "(unknown)"}, ` +
            `but it was not found from ${packageRoot}`,
        );
      }
      const dependencyPackageJson = readManifestPackageJson(dependencyRoot);
      const dependencyVersion = String(dependencyPackageJson.version ?? "").trim();
      if (!dependencyVersion) {
        throw new Error(`Managed dependency ${dependency.name} is missing package.json version at ${dependencyRoot}`);
      }
      const topLevelVersion = topLevelVersions.get(dependency.name);
      const dependencyTarget =
        topLevelVersion === dependencyVersion
          ? packageTargetPath(dependency.name)
          : `${target}/node_modules/${packageTargetPath(dependency.name)}`;

      collect({
        name: dependency.name,
        version: dependencyVersion,
        target: dependencyTarget,
        fromRoot: packageRoot,
        optional: dependency.optional,
      });
    }
  };

  for (const spec of rootSpecs) {
    collect({
      ...spec,
      target: packageTargetPath(spec.name),
      fromRoot: orchestratorDir,
    });
  }

  return [...entries.values()].sort((a, b) => a.target.localeCompare(b.target));
};

const buildManagedDepsManifest = (normalizedOpencodeVersion) => {
  const orchestratorPkg = readJsonFile(resolve(orchestratorDir, "package.json"));
  const specs = [
    {
      name: "@opencode-ai/plugin",
      version: String(orchestratorPkg.dependencies?.["@opencode-ai/plugin"] ?? "").trim(),
    },
    {
      name: "zod",
      version: String(orchestratorPkg.dependencies?.zod ?? "").trim(),
    },
    {
      name: "@ai-sdk/openai-compatible",
      version: String(orchestratorPkg.dependencies?.["@ai-sdk/openai-compatible"] ?? "").trim(),
    },
    {
      name: "@ai-sdk/provider",
      version: String(orchestratorPkg.dependencies?.["@ai-sdk/provider"] ?? "").trim(),
    },
    {
      name: "@ai-sdk/provider-utils",
      version: String(orchestratorPkg.dependencies?.["@ai-sdk/provider-utils"] ?? "").trim(),
    },
    {
      name: "@standard-schema/spec",
      version: String(orchestratorPkg.dependencies?.["@standard-schema/spec"] ?? "").trim(),
    },
    {
      name: "@workflow/serde",
      version: String(orchestratorPkg.dependencies?.["@workflow/serde"] ?? "").trim(),
    },
    {
      name: "eventsource-parser",
      version: String(orchestratorPkg.dependencies?.["eventsource-parser"] ?? "").trim(),
    },
    {
      name: "json-schema",
      version: String(orchestratorPkg.dependencies?.["json-schema"] ?? "").trim(),
    },
  ];

  for (const spec of specs) {
    if (!spec.version || spec.version.startsWith("^") || spec.version.startsWith("~")) {
      throw new Error(`Managed dependency ${spec.name} must be pinned exactly in packages/orchestrator/package.json`);
    }
  }

  const pluginSpec = specs.find((spec) => spec.name === "@opencode-ai/plugin");
  if (pluginSpec?.version !== normalizedOpencodeVersion) {
    throw new Error(
      `Managed @opencode-ai/plugin version ${pluginSpec?.version || "(missing)"} does not match OpenCode ${normalizedOpencodeVersion}`,
    );
  }

  const packages = collectManagedDependencyGraph(specs);

  return {
    schemaVersion: 1,
    packages: packages.map((pkg) => ({
      name: pkg.name,
      version: pkg.version,
      ...(pkg.target === packageTargetPath(pkg.name) ? {} : { target: pkg.target }),
      files: readPackageFilesForManifest(pkg.packageRoot),
    })),
  };
};

const writeManagedDepsManifest = (normalizedOpencodeVersion) => {
  mkdirSync(sidecarDir, { recursive: true });
  const manifest = buildManagedDepsManifest(normalizedOpencodeVersion);
  const content = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(managedDepsManifestPath, content, "utf8");
  if (managedDepsManifestTargetPath) {
    writeFileSync(managedDepsManifestTargetPath, content, "utf8");
  }
};

const copyExecutableSync = (source, target) => {
  copyFileSync(source, target);
  try {
    chmodSync(target, 0o755);
  } catch {
    // Windows and restricted filesystems may ignore POSIX executable bits.
  }
};

const parseChecksum = (content, assetName) => {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, name] = trimmed.split(/\s+/);
    if (name === assetName) return hash.toLowerCase();
    if (trimmed.endsWith(` ${assetName}`)) {
      return trimmed.split(/\s+/)[0]?.toLowerCase() ?? null;
    }
  }
  return null;
};

let didBuildVesloServer = false;
// veslo-server is first-party code. Its package version does not change for every
// local server edit, so an existing sidecar can otherwise silently go stale.
const shouldBuildVesloServer = true;
const bunWindowsBaselineExecutable = ensureWindowsBaselineBunExecutable();
const buildEnv = bunWindowsBaselineExecutable
  ? { ...process.env, BUN_WINDOWS_X64_BASELINE_EXECUTABLE: bunWindowsBaselineExecutable }
  : process.env;

if (shouldBuildVesloServer) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(vesloServerBuildPath)) {
    try {
      unlinkSync(vesloServerBuildPath);
    } catch {
      // ignore
    }
  }
  const vesloServerScript = resolveBuildScript(vesloServerDir);
  if (!existsSync(vesloServerScript)) {
    console.error(`Veslo server build script not found at ${vesloServerScript}`);
    process.exit(1);
  }
  const vesloServerArgs = [vesloServerScript, "--outdir", sidecarDir, "--filename", "veslo-server"];
  if (bunTarget) {
    vesloServerArgs.push("--target", bunTarget);
  }
  const buildResult = spawnSync("bun", vesloServerArgs, {
    cwd: vesloServerDir,
    stdio: "inherit",
    env: buildEnv,
  });

  if (buildResult.status !== 0) {
    process.exit(buildResult.status ?? 1);
  }

  didBuildVesloServer = true;
}

if (existsSync(vesloServerBuildPath)) {
  const shouldCopyCanonical = didBuildVesloServer || !existsSync(vesloServerPath) || isStubBinary(vesloServerPath);
  if (shouldCopyCanonical && vesloServerBuildPath !== vesloServerPath) {
    try {
      if (existsSync(vesloServerPath)) {
        unlinkSync(vesloServerPath);
      }
    } catch {
      // ignore
    }
    copyExecutableSync(vesloServerBuildPath, vesloServerPath);
  }

  if (vesloServerTargetPath) {
    const shouldCopyTarget =
      didBuildVesloServer || !existsSync(vesloServerTargetPath) || isStubBinary(vesloServerTargetPath);
    if (shouldCopyTarget && vesloServerBuildPath !== vesloServerTargetPath) {
      try {
        if (existsSync(vesloServerTargetPath)) {
          unlinkSync(vesloServerTargetPath);
        }
      } catch {
        // ignore
      }
      copyExecutableSync(vesloServerBuildPath, vesloServerTargetPath);
    }
  }
}

if (!existingOpencodeVersion && vesloCodeCandidatePath) {
  existingOpencodeVersion =
    existsSync(vesloCodeCandidatePath) && !isStubBinary(vesloCodeCandidatePath)
      ? readBinaryVersion(vesloCodeCandidatePath)
      : null;
}

// Prefer an explicitly pinned version. Otherwise, follow latest.
const pinnedOpencodeVersion = normalizeVersion(opencodeVersion);
let normalizedOpencodeVersion = pinnedOpencodeVersion;

if (!normalizedOpencodeVersion) {
  normalizedOpencodeVersion = await fetchLatestOpencodeVersion();
}

// If GitHub is unreachable, fall back to whatever we already have.
if (!normalizedOpencodeVersion && existingOpencodeVersion) {
  normalizedOpencodeVersion = normalizeVersion(existingOpencodeVersion);
}

if (!normalizedOpencodeVersion) {
  console.error(
    "OpenCode version could not be resolved. Set OPENCODE_VERSION to pin a version, or ensure GitHub is reachable to use latest."
  );
  process.exit(1);
}

const opencodeAssetByTarget = {
  "aarch64-apple-darwin": "opencode-darwin-arm64.zip",
  "x86_64-apple-darwin": "opencode-darwin-x64-baseline.zip",
  "x86_64-unknown-linux-gnu": "opencode-linux-x64-baseline.tar.gz",
  "aarch64-unknown-linux-gnu": "opencode-linux-arm64.tar.gz",
  "x86_64-pc-windows-msvc": "opencode-windows-x64-baseline.zip",
  "aarch64-pc-windows-msvc": "opencode-windows-arm64.zip",
};

const opencodeAsset =
  opencodeAssetOverride ?? (resolvedTargetTriple ? opencodeAssetByTarget[resolvedTargetTriple] : null);

const opencodeUrl = opencodeAsset
  ? `https://github.com/${opencodeGithubRepo}/releases/download/v${normalizedOpencodeVersion}/${opencodeAsset}`
  : null;

const shouldDownloadOpencode =
  !vesloCodeCandidatePath ||
  !existsSync(vesloCodeCandidatePath) ||
  isStubBinary(vesloCodeCandidatePath) ||
  !existingOpencodeVersion ||
  existingOpencodeVersion !== normalizedOpencodeVersion;

if (!shouldDownloadOpencode) {
  console.log(`OpenCode sidecar already present (${existingOpencodeVersion}).`);
}

if (shouldDownloadOpencode) {
  if (!opencodeAsset || !opencodeUrl) {
    console.error(
      `No OpenCode asset configured for target ${resolvedTargetTriple ?? "unknown"}. Set OPENCODE_ASSET to override.`
    );
    process.exit(1);
  }

  mkdirSync(sidecarDir, { recursive: true });

  const stamp = Date.now();
  const archivePath = join(tmpdir(), `opencode-${stamp}-${opencodeAsset}`);
  const extractDir = join(tmpdir(), `opencode-${stamp}`);

  mkdirSync(extractDir, { recursive: true });

  if (process.platform === "win32") {
    const psQuote = (value) => `'${value.replace(/'/g, "''")}'`;
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      `Invoke-WebRequest -Uri ${psQuote(opencodeUrl)} -OutFile ${psQuote(archivePath)}`,
      `Expand-Archive -Path ${psQuote(archivePath)} -DestinationPath ${psQuote(extractDir)} -Force`,
    ].join("; ");

    const result = spawnSync("powershell", hiddenPowerShellArgs(psScript), {
      stdio: "inherit",
      windowsHide: true,
    });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  } else {
    const downloadResult = spawnSync("curl", ["-fsSL", "-o", archivePath, opencodeUrl], {
      stdio: "inherit",
    });
    if (downloadResult.status !== 0) {
      process.exit(downloadResult.status ?? 1);
    }

    mkdirSync(extractDir, { recursive: true });

    if (opencodeAsset.endsWith(".zip")) {
      const unzipResult = spawnSync("unzip", ["-q", archivePath, "-d", extractDir], {
        stdio: "inherit",
      });
      if (unzipResult.status !== 0) {
        process.exit(unzipResult.status ?? 1);
      }
    } else if (opencodeAsset.endsWith(".tar.gz")) {
      const tarResult = spawnSync("tar", ["-xzf", archivePath, "-C", extractDir], {
        stdio: "inherit",
      });
      if (tarResult.status !== 0) {
        process.exit(tarResult.status ?? 1);
      }
    } else {
      console.error(`Unknown OpenCode archive type: ${opencodeAsset}`);
      process.exit(1);
    }
  }

  const extractedBinary = findOpencodeBinary(extractDir);
  if (!extractedBinary) {
    console.error("OpenCode binary not found after extraction.");
    process.exit(1);
  }

  const opencodeTargets = [vesloCodeTargetPath, vesloCodePath].filter(Boolean);
  for (const target of opencodeTargets) {
    try {
      if (existsSync(target)) {
        unlinkSync(target);
      }
    } catch {
      // ignore
    }
    copyFileSync(extractedBinary, target);
    try {
      chmodSync(target, 0o755);
    } catch {
      // ignore
    }
  }

  console.log(`OpenCode sidecar updated to ${normalizedOpencodeVersion}.`);
}

// Create "opencode" symlinks so the engine's internal `which opencode` check succeeds.
// The engine binary is named veslo-code but verifies itself via `which opencode`.
const opencodeSymlinkTargets = [
  { link: join(sidecarDir, process.platform === "win32" ? "opencode.exe" : "opencode"), target: vesloCodeBaseName },
  ...(resolvedTargetTriple
    ? [{ link: join(sidecarDir, `opencode-${resolvedTargetTriple}${process.platform === "win32" ? ".exe" : ""}`), target: `veslo-code-${resolvedTargetTriple}${process.platform === "win32" ? ".exe" : ""}` }]
    : []),
];
for (const { link, target } of opencodeSymlinkTargets) {
  try {
    if (existsSync(link)) unlinkSync(link);
    symlinkSync(target, link);
  } catch {
    // Fallback: copy the binary if symlink fails (e.g. Windows without dev mode)
    try {
      const sourcePath = join(sidecarDir, target);
      if (existsSync(sourcePath)) {
        copyFileSync(sourcePath, link);
        chmodSync(link, 0o755);
      }
    } catch {
      console.warn(`Failed to create opencode symlink/copy at ${link}`);
    }
  }
}

const opencodeRouterPkgRaw = readFileSync(resolve(opencodeRouterDir, "package.json"), "utf8");
const opencodeRouterPkg = JSON.parse(opencodeRouterPkgRaw);
const opencodeRouterPkgVersion = String(opencodeRouterPkg.version ?? "").trim();
const normalizedOpenCodeRouterVersion = opencodeRouterVersion?.startsWith("v")
  ? opencodeRouterVersion.slice(1)
  : opencodeRouterVersion;
const expectedOpenCodeRouterVersion = normalizedOpenCodeRouterVersion || opencodeRouterPkgVersion;

if (!expectedOpenCodeRouterVersion) {
  console.error("OpenCodeRouter version missing. Set opencodeRouterVersion or ensure package.json has version.");
  process.exit(1);
}

if (normalizedOpenCodeRouterVersion && opencodeRouterPkgVersion && normalizedOpenCodeRouterVersion !== opencodeRouterPkgVersion) {
  console.error(`OpenCodeRouter version mismatch: desktop=${normalizedOpenCodeRouterVersion}, package=${opencodeRouterPkgVersion}`);
  process.exit(1);
}

let didBuildOpenCodeRouter = false;
const shouldBuildOpenCodeRouter = shouldBuildVersionedSidecar(
  vesloCodeRouterBuildPath,
  expectedOpenCodeRouterVersion,
);
if (shouldBuildOpenCodeRouter) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(vesloCodeRouterBuildPath)) {
    try {
      unlinkSync(vesloCodeRouterBuildPath);
    } catch {
      // ignore
    }
  }
  const opencodeRouterScript = resolveBuildScript(opencodeRouterDir);
  if (!existsSync(opencodeRouterScript)) {
    console.error(`OpenCodeRouter build script not found at ${opencodeRouterScript}`);
    process.exit(1);
  }
  const opencodeRouterArgs = [opencodeRouterScript, "--outdir", sidecarDir, "--filename", "veslo-code-router"];
  if (bunTarget) {
    opencodeRouterArgs.push("--target", bunTarget);
  }
  const result = spawnSync("bun", opencodeRouterArgs, { cwd: opencodeRouterDir, stdio: "inherit", env: buildEnv });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  didBuildOpenCodeRouter = true;
}

if (existsSync(vesloCodeRouterBuildPath)) {
  const shouldCopyCanonical = shouldCopyVersionedSidecar(
    vesloCodeRouterPath,
    expectedOpenCodeRouterVersion,
    didBuildOpenCodeRouter,
  );
  if (shouldCopyCanonical && vesloCodeRouterBuildPath !== vesloCodeRouterPath) {
    try {
      if (existsSync(vesloCodeRouterPath)) unlinkSync(vesloCodeRouterPath);
    } catch {
      // ignore
    }
    copyExecutableSync(vesloCodeRouterBuildPath, vesloCodeRouterPath);
  }

  if (vesloCodeRouterTargetPath) {
    const shouldCopyTarget = shouldCopyVersionedSidecar(
      vesloCodeRouterTargetPath,
      expectedOpenCodeRouterVersion,
      didBuildOpenCodeRouter,
    );
    if (shouldCopyTarget && vesloCodeRouterBuildPath !== vesloCodeRouterTargetPath) {
      try {
        if (existsSync(vesloCodeRouterTargetPath)) unlinkSync(vesloCodeRouterTargetPath);
      } catch {
        // ignore
      }
      copyExecutableSync(vesloCodeRouterBuildPath, vesloCodeRouterTargetPath);
    }
  }
}

// Build orchestrator sidecar
const orchestratorPkgRaw = readFileSync(resolve(orchestratorDir, "package.json"), "utf8");
const orchestratorPkg = JSON.parse(orchestratorPkgRaw);
const expectedOrchestratorVersion = String(orchestratorPkg.version ?? "").trim();
if (!expectedOrchestratorVersion) {
  console.error("Orchestrator version missing. Ensure packages/orchestrator/package.json has version.");
  process.exit(1);
}

let didBuildOrchestrator = false;
const shouldBuildOrchestrator = shouldBuildVersionedSidecar(
  orchestratorBuildPath,
  expectedOrchestratorVersion,
);
if (shouldBuildOrchestrator) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(orchestratorBuildPath)) {
    try {
      unlinkSync(orchestratorBuildPath);
    } catch {
      // ignore
    }
  }
  const orchestratorBuildScript = resolveBuildScript(orchestratorDir);
  if (!existsSync(orchestratorBuildScript)) {
    console.error(`Orchestrator build script not found at ${orchestratorBuildScript}`);
    process.exit(1);
  }
  const orchestratorArgs = [
    `--config=${resolve(orchestratorDir, "script", "bunfig.build.toml")}`,
    orchestratorBuildScript,
    "--outdir",
    sidecarDir,
    "--filename",
    orchestratorBaseName,
  ];
  if (bunTarget) {
    orchestratorArgs.push("--target", bunTarget);
  }
  const result = spawnSync("bun", orchestratorArgs, {
    cwd: orchestratorDir,
    stdio: "inherit",
    env: {
      ...buildEnv,
      NODE_ENV: "production",
      BUN_ENV: "production",
    },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  didBuildOrchestrator = true;
}

if (existsSync(orchestratorBuildPath)) {
  const shouldCopyCanonical = shouldCopyVersionedSidecar(
    orchestratorPath,
    expectedOrchestratorVersion,
    didBuildOrchestrator,
  );
  if (shouldCopyCanonical && orchestratorBuildPath !== orchestratorPath) {
    try {
      if (existsSync(orchestratorPath)) unlinkSync(orchestratorPath);
    } catch {
      // ignore
    }
    copyExecutableSync(orchestratorBuildPath, orchestratorPath);
  }

  if (orchestratorTargetPath) {
    const shouldCopyTarget = shouldCopyVersionedSidecar(
      orchestratorTargetPath,
      expectedOrchestratorVersion,
      didBuildOrchestrator,
    );
    if (shouldCopyTarget && orchestratorBuildPath !== orchestratorTargetPath) {
      try {
        if (existsSync(orchestratorTargetPath)) unlinkSync(orchestratorTargetPath);
      } catch {
        // ignore
      }
      copyExecutableSync(orchestratorBuildPath, orchestratorTargetPath);
    }
  }
}

// Build chrome-devtools-mcp shim sidecar
let didBuildChromeDevtools = false;
const shouldBuildChromeDevtools =
  forceBuild || !existsSync(chromeDevtoolsBuildPath) || isStubBinary(chromeDevtoolsBuildPath);
if (shouldBuildChromeDevtools) {
  mkdirSync(sidecarDir, { recursive: true });
  if (existsSync(chromeDevtoolsBuildPath)) {
    try {
      unlinkSync(chromeDevtoolsBuildPath);
    } catch {
      // ignore
    }
  }

  if (!existsSync(chromeDevtoolsShimPath)) {
    console.error(`Chrome DevTools MCP shim source not found at ${chromeDevtoolsShimPath}`);
    process.exit(1);
  }

  const chromeDevtoolsArgs = [
    "build",
    "--compile",
    chromeDevtoolsShimPath,
    "--outfile",
    chromeDevtoolsBuildPath,
  ];
  if (bunTarget) {
    chromeDevtoolsArgs.push("--target", bunTarget);
  }
  if (bunWindowsBaselineExecutable) {
    chromeDevtoolsArgs.push("--compile-executable-path", bunWindowsBaselineExecutable);
  }

  const result = spawnSync("bun", chromeDevtoolsArgs, {
    cwd: __dirname,
    stdio: "inherit",
    env: {
      ...buildEnv,
      NODE_ENV: "production",
      BUN_ENV: "production",
    },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  didBuildChromeDevtools = true;
}

if (existsSync(chromeDevtoolsBuildPath)) {
  const shouldCopyCanonical =
    didBuildChromeDevtools || !existsSync(chromeDevtoolsPath) || isStubBinary(chromeDevtoolsPath);
  if (shouldCopyCanonical && chromeDevtoolsBuildPath !== chromeDevtoolsPath) {
    try {
      if (existsSync(chromeDevtoolsPath)) unlinkSync(chromeDevtoolsPath);
    } catch {
      // ignore
    }
    copyExecutableSync(chromeDevtoolsBuildPath, chromeDevtoolsPath);
  }

  if (chromeDevtoolsTargetPath) {
    const shouldCopyTarget =
      didBuildChromeDevtools ||
      !existsSync(chromeDevtoolsTargetPath) ||
      isStubBinary(chromeDevtoolsTargetPath);
    if (shouldCopyTarget && chromeDevtoolsBuildPath !== chromeDevtoolsTargetPath) {
      try {
        if (existsSync(chromeDevtoolsTargetPath)) unlinkSync(chromeDevtoolsTargetPath);
      } catch {
        // ignore
      }
      copyExecutableSync(chromeDevtoolsBuildPath, chromeDevtoolsTargetPath);
    }
  }
}

const vesloServerVersion = (() => {
  try {
    const raw = readFileSync(resolve(vesloServerDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

const orchestratorVersion = (() => {
  try {
    const raw = readFileSync(resolve(orchestratorDir, "package.json"), "utf8");
    return String(JSON.parse(raw).version ?? "").trim();
  } catch {
    return null;
  }
})();

try {
  writeManagedDepsManifest(normalizedOpencodeVersion);
} catch (error) {
  console.error(`Failed to write opencode-managed-deps.json: ${error}`);
  process.exit(1);
}

const versions = {
  "veslo-code": {
    version: normalizedOpencodeVersion,
    sha256: vesloCodeCandidatePath && existsSync(vesloCodeCandidatePath) ? sha256File(vesloCodeCandidatePath) : null,
  },
  "veslo-server": {
    version: vesloServerVersion,
    sha256: existsSync(vesloServerPath) ? sha256File(vesloServerPath) : null,
  },
  "veslo-code-router": {
    version: expectedOpenCodeRouterVersion,
    sha256: existsSync(vesloCodeRouterPath) ? sha256File(vesloCodeRouterPath) : null,
  },
  "veslo-orchestrator": {
    version: orchestratorVersion,
    sha256: existsSync(orchestratorPath) ? sha256File(orchestratorPath) : null,
  },
  "chrome-devtools-mcp": {
    version: chromeDevtoolsMcpVersion,
    sha256: existsSync(chromeDevtoolsPath) ? sha256File(chromeDevtoolsPath) : null,
  },
  "opencode-managed-deps": {
    version: normalizedOpencodeVersion,
    sha256: existsSync(managedDepsManifestPath) ? sha256File(managedDepsManifestPath) : null,
  },
};

const missing = Object.entries(versions)
  .filter(([, info]) => !info.version || !info.sha256)
  .map(([name]) => name);

if (missing.length) {
  console.error(`Sidecar version metadata incomplete for: ${missing.join(", ")}`);
  process.exit(1);
}

const versionsPath = join(sidecarDir, "versions.json");
try {
  mkdirSync(sidecarDir, { recursive: true });
  const content = JSON.stringify(versions, null, 2) + "\n";
  writeFileSync(versionsPath, content, "utf8");
  if (resolvedTargetTriple) {
    const targetSuffix = process.platform === "win32" ? ".exe" : "";
    const targetVersionsPath = join(sidecarDir, `versions.json-${resolvedTargetTriple}${targetSuffix}`);
    writeFileSync(targetVersionsPath, content, "utf8");
  }
} catch (error) {
  console.error(`Failed to write versions.json: ${error}`);
  process.exit(1);
}
