import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const json = process.argv.includes("--json");

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs"]);
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
const SCAN_ROOTS = [
  "packages/app/src/app",
  "packages/server/src",
  "packages/orchestrator/src",
  "packages/desktop/src-tauri/src",
  "packages/web",
  "services/ai-gateway/src",
  "services/den/src",
  "services/openwork-share/api",
  "services/worker-manager/src",
];

// These names are compatibility inputs only. New code must use the server-owned
// runtime authorization and `x-veslo-session-id` instead of emitting them.
const LEGACY_HEADERS = [
  {
    token: "x-session-id",
    constants: ["OPENCODE_SESSION_ID_HEADER"],
    allowedFiles: new Set([
      "packages/server/src/ai-gateway-proxy-headers.ts",
      "packages/server/src/server.ts",
    ]),
  },
  {
    token: "x-session-affinity",
    constants: ["OPENCODE_SESSION_AFFINITY_HEADER"],
    allowedFiles: new Set([
      "packages/server/src/ai-gateway-proxy-headers.ts",
      "packages/server/src/server.ts",
    ]),
  },
  {
    token: "x-veslo-gateway-token",
    constants: ["VESLO_GATEWAY_TOKEN_HEADER", "GATEWAY_ACCESS_TOKEN_HEADER"],
    allowedFiles: new Set([
      "packages/server/src/request-headers.ts",
      "packages/server/src/ai-gateway-proxy-headers.ts",
      "packages/server/src/server.ts",
      "services/ai-gateway/src/http/proxy.ts",
    ]),
  },
];

function normalizePath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function isTestPath(path) {
  return /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(path);
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(path, out);
    } else if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
      out.push(path);
    }
  }
  return out;
}

function rustTestLineSet(file, lines) {
  if (!file.endsWith(".rs")) return new Set();
  const testLines = new Set();
  let awaitingModule = false;
  let moduleDepth = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (moduleDepth !== null) {
      testLines.add(index);
      moduleDepth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      if (moduleDepth <= 0) moduleDepth = null;
      continue;
    }
    if (/^\s*#\[cfg\(test\)\]\s*$/.test(line)) {
      testLines.add(index);
      awaitingModule = true;
      continue;
    }
    if (awaitingModule && /^\s*mod\s+\w+\s*\{/.test(line)) {
      testLines.add(index);
      moduleDepth = (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
      awaitingModule = false;
      continue;
    }
    awaitingModule = false;
  }
  return testLines;
}

const files = [];
for (const root of SCAN_ROOTS) await walk(resolve(repoRoot, root), files);

const accepted = [];
const findings = [];
for (const path of files) {
  const file = normalizePath(path);
  if (isTestPath(file)) continue;
  const lines = (await readFile(path, "utf8")).split(/\r?\n/);
  const inlineTestLines = rustTestLineSet(file, lines);
  for (let index = 0; index < lines.length; index += 1) {
    if (inlineTestLines.has(index)) continue;
    const line = lines[index];
    const lowerLine = line.toLowerCase();
    for (const rule of LEGACY_HEADERS) {
      const mentionsToken = lowerLine.includes(rule.token);
      const mentionedConstants = rule.constants.filter((constant) => line.includes(constant));
      if (!mentionsToken && mentionedConstants.length === 0) continue;
      const entry = {
        file,
        line: index + 1,
        header: rule.token,
        via: mentionsToken ? "literal" : `constant:${mentionedConstants.join(",")}`,
      };
      if (rule.allowedFiles.has(file)) accepted.push(entry);
      else findings.push(entry);
    }
  }
}

accepted.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
const report = { scannedFiles: files.length, accepted: accepted.length, findings: findings.length, findingsEntries: findings };

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`Legacy header audit scanned ${files.length} production files. Compatibility-owner references: ${accepted.length}. Findings: ${findings.length}.`);
  for (const entry of findings) {
    console.error(`ERROR ${entry.file}:${entry.line} ${entry.header} (${entry.via}) is outside its compatibility owner`);
  }
}

if (findings.length > 0) process.exit(1);
