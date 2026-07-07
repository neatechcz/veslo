import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const CODE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".output",
  ".turbo",
  "coverage",
  "dist",
  "gen",
  "node_modules",
  "target",
]);

const owners = [
  { name: "app", root: "packages/app" },
  { name: "server", root: "packages/server" },
  { name: "desktop", root: "packages/desktop" },
  { name: "orchestrator", root: "packages/orchestrator" },
  { name: "code-router", root: "packages/opencode-router" },
  { name: "document-runtime", root: "packages/document-runtime" },
  { name: "e2e", root: "packages/e2e" },
  { name: "web", root: "packages/web" },
  { name: "den", root: "services/den" },
  { name: "ai-gateway", root: "services/ai-gateway" },
  { name: "worker-manager", root: "services/worker-manager" },
].map((owner) => ({
  ...owner,
  absRoot: resolve(repoRoot, owner.root),
}));

const forbiddenOwnerImports = new Map([
  ["app", new Set(["server", "desktop", "orchestrator", "code-router", "den", "ai-gateway", "worker-manager"])],
  ["server", new Set(["app", "desktop", "den", "ai-gateway", "worker-manager", "web"])],
  ["orchestrator", new Set(["app", "server", "desktop", "den", "ai-gateway", "worker-manager", "web"])],
  ["code-router", new Set(["app", "server", "desktop", "den", "ai-gateway", "worker-manager", "web"])],
  ["den", new Set(["app", "server", "desktop", "orchestrator", "code-router", "ai-gateway", "worker-manager"])],
  ["ai-gateway", new Set(["app", "server", "desktop", "orchestrator", "code-router", "den", "worker-manager"])],
  ["worker-manager", new Set(["app", "server", "desktop", "orchestrator", "code-router", "den", "ai-gateway"])],
]);

const rootsToScan = [
  "packages/app/src",
  "packages/server/src",
  "packages/desktop/scripts",
  "packages/desktop/src-tauri/src",
  "packages/orchestrator/src",
  "packages/opencode-router/src",
  "packages/document-runtime/src",
  "packages/e2e",
  "packages/web",
  "services/den/src",
  "services/ai-gateway/src",
  "services/worker-manager/src",
  "scripts",
];

const importPattern =
  /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;

function normalizePath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function ownerFor(absPath) {
  return owners.find((owner) => {
    const rel = relative(owner.absRoot, absPath);
    return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
  });
}

function isTestPath(path) {
  const normalized = normalizePath(path);
  return /(^|\/)(tests?|__tests__)\//.test(normalized) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(normalized);
}

function lineFor(contents, index) {
  return contents.slice(0, index).split(/\r?\n/).length;
}

function stripSpecifierSuffix(specifier) {
  return specifier.replace(/[?#].*$/, "");
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) {
        await walk(resolve(dir, entry.name), out);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const path = resolve(dir, entry.name);
    if (CODE_EXTENSIONS.has(extname(path))) out.push(path);
  }
  return out;
}

function addFinding(findings, severity, file, line, specifier, message) {
  findings.push({
    severity,
    file: normalizePath(file),
    line,
    specifier,
    message,
  });
}

async function existingRoot(path) {
  const candidates = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    `${path}.jsx`,
    `${path}.mjs`,
    `${path}.cjs`,
    resolve(path, "index.ts"),
    resolve(path, "index.tsx"),
    resolve(path, "index.js"),
    resolve(path, "index.mjs"),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Keep trying likely extension/index variants.
    }
  }
  return path;
}

const files = [];
for (const root of rootsToScan) {
  await walk(resolve(repoRoot, root), files);
}

const findings = [];
for (const file of files) {
  const contents = await readFile(file, "utf8");
  const sourceOwner = ownerFor(file);
  importPattern.lastIndex = 0;
  let match;
  while ((match = importPattern.exec(contents))) {
    const rawSpecifier = match[1] ?? match[2] ?? match[3] ?? "";
    const specifier = stripSpecifierSuffix(rawSpecifier);
    if (!specifier.startsWith(".")) continue;

    const targetPath = await existingRoot(resolve(dirname(file), specifier));
    const targetOwner = ownerFor(targetPath);
    if (!sourceOwner || !targetOwner) continue;

    const line = lineFor(contents, match.index);
    if (sourceOwner.name !== targetOwner.name) {
      addFinding(
        findings,
        "error",
        file,
        line,
        rawSpecifier,
        `Relative import crosses owner boundary: ${sourceOwner.name} -> ${targetOwner.name}`,
      );
      continue;
    }

    const forbiddenTargets = forbiddenOwnerImports.get(sourceOwner.name);
    if (forbiddenTargets?.has(targetOwner.name)) {
      addFinding(
        findings,
        "error",
        file,
        line,
        rawSpecifier,
        `Forbidden owner import: ${sourceOwner.name} -> ${targetOwner.name}`,
      );
    }

    if (!isTestPath(file) && isTestPath(targetPath)) {
      addFinding(findings, "error", file, line, rawSpecifier, "Production code imports a test/spec file");
    }
  }
}

if (findings.length > 0) {
  console.error("Import boundary audit found violations:\n");
  for (const finding of findings) {
    console.error(
      `${finding.severity.toUpperCase()} ${finding.file}:${finding.line} ${finding.specifier} - ${finding.message}`,
    );
  }
  process.exit(1);
}

console.log(`Import boundary audit passed. Scanned ${files.length} files.`);
