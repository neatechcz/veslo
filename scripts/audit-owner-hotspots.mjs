import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const showAll = process.argv.includes("--all");
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

const thresholds = {
  lines: Number(process.env.OWNER_HOTSPOT_LINES ?? 650),
  imports: Number(process.env.OWNER_HOTSPOT_IMPORTS ?? 35),
  exports: Number(process.env.OWNER_HOTSPOT_EXPORTS ?? 30),
  routes: Number(process.env.OWNER_HOTSPOT_ROUTES ?? 8),
  catches: Number(process.env.OWNER_HOTSPOT_CATCHES ?? 12),
  any: Number(process.env.OWNER_HOTSPOT_ANY ?? 5),
};

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

function countMatches(contents, pattern) {
  return contents.match(pattern)?.length ?? 0;
}

function overage(value, threshold) {
  if (threshold <= 0 || value <= threshold) return 0;
  return value - threshold;
}

function score(metrics) {
  return (
    overage(metrics.lines, thresholds.lines) * 0.05 +
    overage(metrics.imports, thresholds.imports) * 1.5 +
    overage(metrics.exports, thresholds.exports) * 1.2 +
    overage(metrics.routes, thresholds.routes) * 5 +
    overage(metrics.catches, thresholds.catches) * 2 +
    overage(metrics.any, thresholds.any) * 3
  );
}

const files = [];
for (const root of SCAN_ROOTS) await walk(resolve(repoRoot, root), files);

const rows = [];
for (const file of files) {
  if (isTestPath(file)) continue;
  const contents = await readFile(file, "utf8");
  const lines = contents.split(/\r?\n/).length;
  const metrics = {
    file: normalizePath(file),
    lines,
    imports: countMatches(contents, /^\s*import\b/gm),
    exports: countMatches(contents, /^\s*export\b/gm),
    routes: countMatches(contents, /addRoute\s*\(\s*routes\s*,/g),
    catches: countMatches(contents, /\bcatch\s*(?:\(|\{)/g),
    any: countMatches(contents, /\b(as\s+any|:\s*any\b|<any>)/g),
    todos: countMatches(contents, /\b(TODO|FIXME)\b/g),
  };
  metrics.score = score(metrics);
  if (showAll || metrics.score > 0) rows.push(metrics);
}

rows.sort((left, right) => right.score - left.score || right.lines - left.lines);

console.log(`Owner hotspot audit scanned ${files.length} files. Hotspots: ${rows.length}`);
console.log(
  `Thresholds: lines>${thresholds.lines}, imports>${thresholds.imports}, exports>${thresholds.exports}, routes>${thresholds.routes}, catches>${thresholds.catches}, any>${thresholds.any}`,
);

if (rows.length > 0) {
  console.log("\nscore  lines  imports  exports  routes  catches  any  todos  file");
  for (const row of rows.slice(0, showAll ? rows.length : 40)) {
    console.log(
      `${row.score.toFixed(1).padStart(5)}  ${String(row.lines).padStart(5)}  ${String(row.imports).padStart(7)}  ${String(row.exports).padStart(7)}  ${String(row.routes).padStart(6)}  ${String(row.catches).padStart(7)}  ${String(row.any).padStart(3)}  ${String(row.todos).padStart(5)}  ${row.file}`,
    );
  }
  if (!showAll && rows.length > 40) console.log(`... ${rows.length - 40} more`);
}

console.log("\nOwner hotspot audit completed.");
