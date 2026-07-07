import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const strict = process.argv.includes("--strict");
const maxSignals = Number(process.argv.find((arg) => arg.startsWith("--max="))?.slice("--max=".length) ?? "10");

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const SKIP_DIRS = new Set([".git", ".turbo", "coverage", "dist", "gen", "node_modules", "target"]);
const SCAN_ROOTS = [
  "packages/app/src/app",
  "packages/server/src",
  "packages/orchestrator/src",
  "packages/desktop/src-tauri/src",
];

const surfaces = [
  {
    id: "mcp",
    label: "MCP",
    pathHints: ["mcp", "opencode-config-sanitizer"],
    testHints: ["mcp"],
    keywords: [
      "mcp",
      "auth",
      "token",
      "runtime-token",
      "oauth",
      "disconnect",
      "tools",
      "chrome-devtools",
      "sidecar",
      "reload",
    ],
    anchors: [
      "packages/server/src/routes/mcp.ts",
      "packages/app/src/app/lib/veslo-server-domains/mcp.ts",
      "packages/orchestrator/src/opencode-config-sanitizer.ts",
    ],
  },
  {
    id: "skills",
    label: "Skills / materialization",
    pathHints: ["skill"],
    testHints: ["skill", "materialization"],
    keywords: [
      "skill",
      "materialization",
      "registry",
      "reload",
      "disabled",
      "enabled",
      "user-global",
      "sync",
      "rollout",
    ],
    anchors: [
      "packages/server/src/routes/workspace-skills.ts",
      "packages/server/src/routes/skill-materialization.ts",
      "packages/app/src/app/context/workspace-skill-materialization.ts",
      "packages/app/src/app/lib/veslo-server-domains/skills.ts",
    ],
  },
  {
    id: "conversation-resume",
    label: "Conversation resume / engine continuity",
    pathHints: ["conversation", "session-event", "session-reconnect", "transcript", "lifecycle"],
    testHints: ["conversation", "session-event", "session-reconnect", "transcript", "lifecycle", "pending-session"],
    keywords: [
      "conversation",
      "conversation_run",
      "engine",
      "engineSessionId",
      "opencodeSessionId",
      "resume",
      "reconnect",
      "transcript",
      "prefetch",
      "stale",
      "activeRun",
      "Answering",
    ],
    anchors: [
      "packages/server/src/routes/conversations.ts",
      "packages/server/src/conversation-service.ts",
      "packages/server/src/conversation-run-lifecycle-controller.ts",
      "packages/app/src/app/context/session-event-stream.ts",
      "packages/app/src/app/lib/veslo-server-domains/conversations.ts",
      "packages/app/src/app/pages/session-conversation-flow.ts",
    ],
  },
];

const rules = [
  {
    id: "explicit-any",
    severity: "medium",
    pattern: /\b(as\s+any|:\s*any\b|<any>)/,
    message: "explicit any at a state or API boundary",
  },
  {
    id: "unknown-double-cast",
    severity: "medium",
    pattern: /\bunknown\s+as\b|\bas\s+unknown\s+as\b/,
    message: "double/unknown cast can hide contract drift",
  },
  {
    id: "empty-string-coercion",
    severity: "medium",
    pattern: /String\s*\([^;\n]*\?\?\s*["']["'][^;\n]*\)/,
    message: "missing payload value can become a valid-looking empty string",
  },
  {
    id: "direct-route-param",
    severity: "info",
    pattern: /\bctx\.params\.[A-Za-z0-9_]+\b/,
    message: "route param usage; verify the nearby guard owns validation",
  },
  {
    id: "fallback-or-legacy",
    severity: "info",
    pattern: /\b(fallback|legacy|sessionless|degraded|best[- ]effort|stale)\b/i,
    exclude: /\bfallback\s*=|<Show\b/,
    message: "fallback/legacy path; verify scope, trace, and tests",
  },
  {
    id: "todo-critical-surface",
    severity: "medium",
    pattern: /(?:\/\/|\/\*|\*)\s*(TODO|FIXME)\b/i,
    message: "unfinished note inside a critical workflow surface",
  },
];

const addRoutePattern = /addRoute\s*\(\s*routes\s*,\s*["']([A-Z]+)["']\s*,\s*["']([^"']+)["']/g;
const requestJsonPathPattern = /\brequestJson(?:Raw)?(?:<[^>]+>)?\s*\([^,]+,\s*(["'`])([^"'`]+)\1/g;

function normalizePath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function lineFor(contents, index) {
  return contents.slice(0, index).split(/\r?\n/).length;
}

function isTestPath(path) {
  const normalized = normalizePath(path);
  return /(^|\/)(tests?|__tests__)\//.test(normalized) || /\.(test|spec)\.[cm]?[tj]sx?$/.test(normalized);
}

function pathMatchesHints(path, hints) {
  const normalized = normalizePath(path).toLowerCase();
  return hints.some((hint) => normalized.includes(hint.toLowerCase()));
}

function keywordRegex(keywords) {
  return new RegExp(`\\b(${keywords.map(escapeRegExp).join("|")})\\b`, "i");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function shortLine(line) {
  const trimmed = line.trim().replace(/\s+/g, " ");
  return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
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

async function readMaybe(path) {
  try {
    return await readFile(resolve(repoRoot, path), "utf8");
  } catch {
    return null;
  }
}

function collectRoutes(contents, file) {
  const routes = [];
  addRoutePattern.lastIndex = 0;
  let match;
  while ((match = addRoutePattern.exec(contents))) {
    routes.push({
      method: match[1],
      path: match[2],
      file,
      line: lineFor(contents, match.index),
    });
  }
  return routes;
}

function collectClientPaths(contents, file) {
  const paths = [];
  requestJsonPathPattern.lastIndex = 0;
  let match;
  while ((match = requestJsonPathPattern.exec(contents))) {
    paths.push({
      path: match[2],
      file,
      line: lineFor(contents, match.index),
    });
  }
  return paths;
}

function catchReturnsFallback(lines, index) {
  if (!/\bcatch\s*(?:\(|\{)/.test(lines[index])) return false;
  const window = lines.slice(index, index + 10).join("\n");
  return /\breturn\s+(null|false|undefined|\[\]|\{\})\s*;?/.test(window);
}

function scanFile(surface, file, contents) {
  const lines = contents.split(/\r?\n/);
  const keywordPattern = keywordRegex(surface.keywords);
  const signals = [];
  let keywordHits = 0;
  let catchCount = 0;
  let requestJsonCount = 0;
  let addRouteCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    if (keywordPattern.test(line)) keywordHits += 1;
    if (/\bcatch\s*(?:\(|\{)/.test(line)) catchCount += 1;
    if (/\brequestJson(?:Raw)?\b/.test(line)) requestJsonCount += 1;
    if (/\baddRoute\s*\(/.test(line)) addRouteCount += 1;

    for (const rule of rules) {
      if (rule.exclude?.test(line)) continue;
      if (rule.pattern.test(line)) {
        signals.push({
          severity: rule.severity,
          rule: rule.id,
          message: rule.message,
          file,
          line: lineNumber,
          text: shortLine(line),
        });
      }
    }

    if (catchReturnsFallback(lines, index)) {
      signals.push({
        severity: "medium",
        rule: "catch-return-fallback",
        message: "catch block returns a fallback value",
        file,
        line: lineNumber,
        text: shortLine(line),
      });
    }
  }

  return {
    file,
    lines: lines.length,
    keywordHits,
    catchCount,
    requestJsonCount,
    addRouteCount,
    routes: collectRoutes(contents, file),
    clientPaths: collectClientPaths(contents, file),
    signals,
  };
}

function severityWeight(severity) {
  if (severity === "high") return 6;
  if (severity === "medium") return 3;
  return 1;
}

function sortHotspots(left, right) {
  const leftScore =
    left.keywordHits + left.catchCount * 2 + left.requestJsonCount * 2 + left.addRouteCount * 3 + left.signals.length * 2;
  const rightScore =
    right.keywordHits +
    right.catchCount * 2 +
    right.requestJsonCount * 2 +
    right.addRouteCount * 3 +
    right.signals.length * 2;
  return rightScore - leftScore || left.file.localeCompare(right.file);
}

function printSurfaceReport(report) {
  console.log(`\n=== ${report.label} ===`);
  console.log(
    `source files: ${report.files.length}, tests: ${report.tests.length}, routes: ${report.routes.length}, client paths: ${report.clientPaths.length}`,
  );

  if (report.missingAnchors.length) {
    console.log(`missing anchors: ${report.missingAnchors.join(", ")}`);
  }

  const bySeverity = report.signals.reduce(
    (acc, signal) => {
      acc[signal.severity] = (acc[signal.severity] ?? 0) + 1;
      return acc;
    },
    { high: 0, medium: 0, info: 0 },
  );
  console.log(`signals: medium=${bySeverity.medium ?? 0}, info=${bySeverity.info ?? 0}`);

  const topHotspots = [...report.metrics].sort(sortHotspots).slice(0, 6);
  if (topHotspots.length) {
    console.log("top hotspots:");
    for (const item of topHotspots) {
      console.log(
        `  ${item.file} lines=${item.lines} keywords=${item.keywordHits} catches=${item.catchCount} routes=${item.addRouteCount} requests=${item.requestJsonCount} signals=${item.signals.length}`,
      );
    }
  }

  const actionableSignals = [...report.signals]
    .sort(
      (left, right) =>
        severityWeight(right.severity) - severityWeight(left.severity) ||
        left.file.localeCompare(right.file) ||
        left.line - right.line,
    )
    .slice(0, maxSignals);

  if (actionableSignals.length) {
    console.log("top signals:");
    for (const signal of actionableSignals) {
      console.log(`  [${signal.severity}] ${signal.rule} ${signal.file}:${signal.line} ${signal.text}`);
    }
    if (report.signals.length > actionableSignals.length) {
      console.log(`  ... ${report.signals.length - actionableSignals.length} more`);
    }
  }

  if (report.tests.length) {
    console.log("test anchors:");
    for (const test of report.tests.slice(0, 8)) console.log(`  ${test}`);
    if (report.tests.length > 8) console.log(`  ... ${report.tests.length - 8} more`);
  } else {
    console.log("test anchors: none discovered by path/content hints");
  }
}

const allFiles = [];
for (const root of SCAN_ROOTS) await walk(resolve(repoRoot, root), allFiles);

const fileContents = new Map();
async function contentsFor(path) {
  if (fileContents.has(path)) return fileContents.get(path);
  const contents = await readFile(resolve(repoRoot, path), "utf8");
  fileContents.set(path, contents);
  return contents;
}

const reports = [];
for (const surface of surfaces) {
  const sourceSet = new Set(surface.anchors);
  const testSet = new Set();
  const keywordPattern = keywordRegex(surface.keywords);

  for (const absPath of allFiles) {
    const relPath = normalizePath(absPath);
    if (pathMatchesHints(absPath, surface.pathHints)) {
      if (isTestPath(absPath)) testSet.add(relPath);
      else sourceSet.add(relPath);
      continue;
    }

    if (isTestPath(absPath) && pathMatchesHints(absPath, surface.testHints)) testSet.add(relPath);
  }

  const missingAnchors = [];
  const metrics = [];
  for (const file of [...sourceSet].sort()) {
    const contents = await readMaybe(file);
    if (contents === null) {
      if (surface.anchors.includes(file)) missingAnchors.push(file);
      continue;
    }
    metrics.push(scanFile(surface, file, contents));
  }

  const signals = metrics.flatMap((item) => item.signals);
  reports.push({
    id: surface.id,
    label: surface.label,
    files: metrics.map((item) => item.file),
    tests: [...testSet].sort(),
    routes: metrics.flatMap((item) => item.routes),
    clientPaths: metrics.flatMap((item) => item.clientPaths),
    missingAnchors,
    metrics,
    signals,
  });
}

console.log("Workflow surface audit");
console.log(`scanned roots: ${SCAN_ROOTS.join(", ")}`);
console.log("--strict fails only on missing anchors or missing discovered tests, not on heuristic signals.");

for (const report of reports) printSurfaceReport(report);

const hardProblems = reports.flatMap((report) => [
  ...report.missingAnchors.map((anchor) => `${report.id}: missing anchor ${anchor}`),
  ...(report.tests.length === 0 ? [`${report.id}: no matching tests discovered`] : []),
]);

if (strict && hardProblems.length) {
  console.error("\nWorkflow surface audit failed in --strict mode:");
  for (const problem of hardProblems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log("\nWorkflow surface audit completed.");
