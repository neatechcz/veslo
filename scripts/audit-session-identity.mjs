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

function requireSourceInvariant(file, description, pattern, findings) {
  const contents = sourceByPath.get(file) ?? "";
  if (!pattern.test(contents)) findings.push({ file, description });
}

const files = [];
for (const root of SCAN_ROOTS) await walk(resolve(repoRoot, root), files);

const sourceByPath = new Map();
const sessionKeyedMaps = [];
const unresolvedTemplateUses = [];
for (const path of files) {
  const file = normalizePath(path);
  if (isTestPath(file)) continue;
  const contents = await readFile(path, "utf8");
  sourceByPath.set(file, contents);
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const mapMatch = /\b(?:const|let|private)\s+([A-Za-z_$][\w$]*(?:[sS]ession)[\w$]*)\s*=\s*new Map\b/.exec(line);
    if (mapMatch) sessionKeyedMaps.push({ file, line: index + 1, name: mapMatch[1] });
    if (/['"]\$\{OPENCODE_SESSION_ID\}['"]/.test(line)) {
      unresolvedTemplateUses.push({ file, line: index + 1 });
    }
  }
}

const findings = [];
requireSourceInvariant(
  "packages/server/src/ai-gateway-runtime-owner.ts",
  "AI gateway workspace fallback must require exactly one active run and one workspace candidate",
  /activeContexts\.length\s*===\s*1\s*&&\s*workspaceCandidates\.length\s*===\s*1/,
  findings,
);
requireSourceInvariant(
  "packages/server/src/ai-gateway-runtime-owner.ts",
  "AI gateway resolver must record an ambiguous workspace fallback instead of choosing a session",
  /workspaceFallbackSuppressedReason:\s*["']ambiguous-active-run-context["']/,
  findings,
);
requireSourceInvariant(
  "packages/server/src/ai-gateway-runtime-owner.ts",
  "A concrete OpenCode request session header must resolve before workspace fallback",
  /if\s*\(openCodeSessionId\)[\s\S]{0,500}?source:\s*["']opencode-session-header["']/,
  findings,
);
requireSourceInvariant(
  "packages/server/src/ai-gateway-runtime-owner.ts",
  "A concrete session lookup must receive the request workspace so a malformed duplicate upstream id cannot cross-correlate runs",
  /latestRunBySession\(incomingSessionId,\s*workspaceId\)[\s\S]{0,700}?latestRunBySession\(openCodeSessionId,\s*workspaceId\)/,
  findings,
);
requireSourceInvariant(
  "packages/server/src/server.ts",
  "Ambiguous placeholder correlation must be rejected before an AI gateway provider request is forwarded",
  /workspaceFallbackSuppressedReason\s*===\s*["']ambiguous-active-run-context["']/,
  findings,
);
requireSourceInvariant(
  "packages/server/src/conversation-transcript-ingest.ts",
  "Transcript identity must include workspace, directory, and OpenCode session id",
  /\$\{identity\.workspaceId\}\\0\$\{identity\.directory\}\\0\$\{identity\.opencodeSessionId\}/,
  findings,
);
requireSourceInvariant(
  "packages/app/src/app/lib/ui-conversation-scope.ts",
  "UI conversation keys must include workspace and OpenCode session id",
  /encodeKeyPart\(workspaceId\)[\s\S]{0,500}?encodeKeyPart\(opencodeSessionId\)/,
  findings,
);

const allowedTemplateOwners = new Set([
  "packages/app/src/app/lib/opencode.ts",
  "packages/app/src/app/lib/ai-access.ts",
  "packages/server/src/server.ts",
  "packages/desktop/src-tauri/src/commands/workspace.rs",
]);
for (const entry of unresolvedTemplateUses) {
  if (!allowedTemplateOwners.has(entry.file)) {
    findings.push({
      file: entry.file,
      line: entry.line,
      description: "Unresolved OpenCode session template is outside a reviewed configuration or sanitization owner",
    });
  }
}

sessionKeyedMaps.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
const report = {
  scannedFiles: sourceByPath.size,
  sessionKeyedMaps,
  unresolvedTemplateUses,
  findings,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`Session identity audit scanned ${report.scannedFiles} production files.`);
  console.log(`Session-keyed maps for explicit owner review: ${sessionKeyedMaps.length}.`);
  for (const entry of sessionKeyedMaps) console.log(`INFO ${entry.file}:${entry.line} ${entry.name}`);
  console.log(`Unresolved OpenCode session template owners: ${unresolvedTemplateUses.length}.`);
  for (const entry of unresolvedTemplateUses) console.log(`INFO ${entry.file}:${entry.line}`);
  if (findings.length > 0) {
    console.error("\nSession identity contract violations:\n");
    for (const finding of findings) {
      console.error(`ERROR ${finding.file}${finding.line ? `:${finding.line}` : ""} ${finding.description}`);
    }
  }
}

if (findings.length > 0) process.exit(1);
