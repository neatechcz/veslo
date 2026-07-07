import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const strict = process.argv.includes("--strict");
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const SKIP_DIRS = new Set([".git", ".turbo", "coverage", "dist", "gen", "node_modules", "target"]);
const SCAN_ROOTS = [
  "packages/app/src/app",
  "packages/server/src",
  "packages/orchestrator/src",
  "packages/opencode-router/src",
  "services/den/src",
  "services/ai-gateway/src",
  "services/worker-manager/src",
];

const rules = [
  {
    id: "unsafe-any",
    severity: "high",
    pattern: /\b(as\s+any|:\s*any\b|<any>)/,
    message: "Explicit any weakens boundary/type checks",
  },
  {
    id: "unknown-cast",
    severity: "medium",
    pattern: /\bunknown\s+as\b|\bas\s+unknown\s+as\b/,
    message: "Double/unknown cast may hide contract drift",
  },
  {
    id: "direct-route-param",
    severity: "high",
    pattern: /\b(resolveWorkspace|decodeURIComponent|String)\s*\([^;\n]*ctx\.params\.[A-Za-z0-9_]+|ctx\.params\.[A-Za-z0-9_]+/,
    message: "Route param is used directly; prefer an explicit guard near the route boundary",
  },
  {
    id: "empty-string-coercion",
    severity: "medium",
    pattern: /String\s*\([^;\n]*\?\?\s*["']["'][^;\n]*\)/,
    message: "String(... ?? \"\") can turn a missing payload field into a valid-looking value",
  },
  {
    id: "fallback-keyword",
    severity: "info",
    pattern: /\b(fallback|legacy|sessionless|best[- ]effort|quiet|degraded)\b/i,
    exclude: /\bfallback\s*(?:=|\?:)|<Show\b/,
    message: "Fallback/legacy/sessionless path; verify that scope and tests are explicit",
  },
  {
    id: "auth-todo",
    severity: "medium",
    pattern: /\b(TODO|FIXME).*\bauth\b|\bauth\b.*\b(TODO|FIXME)\b/i,
    message: "Authentication-related TODO/FIXME",
  },
];

function normalizePath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function isTestPath(path) {
  const normalized = normalizePath(path);
  return /(^|\/)(tests?|__tests__)\//.test(normalized) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(normalized);
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
      if (!SKIP_DIRS.has(entry.name)) await walk(resolve(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
      out.push(resolve(dir, entry.name));
    }
  }
  return out;
}

function addFinding(findings, rule, file, lineNumber, line) {
  findings.push({
    rule: rule.id,
    severity: rule.severity,
    file: normalizePath(file),
    lineNumber,
    line: line.trim(),
    message: rule.message,
  });
}

function catchReturnFallback(lines, index) {
  if (!/\bcatch\s*(?:\(|\{)/.test(lines[index])) return false;
  const window = lines.slice(index, index + 10).join("\n");
  return /\breturn\s+(null|false|undefined|\[\]|\{\})\s*;?/.test(window);
}

const files = [];
for (const root of SCAN_ROOTS) await walk(resolve(repoRoot, root), files);

const findings = [];
for (const file of files) {
  if (isTestPath(file)) continue;
  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    for (const rule of rules) {
      if (rule.exclude?.test(line)) continue;
      if (rule.pattern.test(line)) addFinding(findings, rule, file, lineNumber, line);
    }
    if (catchReturnFallback(lines, index)) {
      addFinding(
        findings,
        {
          id: "catch-return-fallback",
          severity: "medium",
          message: "catch block returns a fallback value; verify that errors are surfaced or traced",
        },
        file,
        lineNumber,
        line,
      );
    }
  }
}

const byRule = new Map();
for (const finding of findings) {
  const entries = byRule.get(finding.rule) ?? [];
  entries.push(finding);
  byRule.set(finding.rule, entries);
}

console.log(`Fallback risk audit scanned ${files.length} files (${findings.length} findings).`);

for (const [rule, entries] of [...byRule.entries()].sort((left, right) => right[1].length - left[1].length)) {
  const severity = entries[0]?.severity ?? "info";
  console.log(`\n${rule} (${severity}) - ${entries.length}`);
  for (const entry of entries.slice(0, 25)) {
    console.log(`${entry.file}:${entry.lineNumber} ${entry.line}`);
  }
  if (entries.length > 25) console.log(`... ${entries.length - 25} more`);
}

if (strict && findings.some((finding) => finding.severity === "high")) {
  console.error("\nFallback risk audit failed in --strict mode because high-severity findings exist.");
  process.exit(1);
}

console.log("\nFallback risk audit completed.");
