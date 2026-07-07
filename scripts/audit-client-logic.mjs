import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const strict = process.argv.includes("--strict");
const json = process.argv.includes("--json");
const showAll = process.argv.includes("--all");
const maxRows = numberArg("--max", 40);
const minScore = numberArg("--min-score", 70);

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set([".git", ".turbo", "coverage", "dist", "gen", "node_modules", "target"]);
const SCAN_ROOTS = ["packages/app/src/app"];
const IGNORE_MARKER = "client-logic-monitor: ignore";

const signalRules = [
  {
    id: "server-request",
    points: 9,
    cap: 3,
    pattern: /\b(requestJson|requestJsonRaw|createVesloServerClient|fetchJson|fetch)\s*(?:<|\()/g,
    message: "server/API request orchestration in the app layer",
  },
  {
    id: "tauri-or-runtime-command",
    points: 8,
    cap: 3,
    pattern:
      /\b(invoke|readEngineInfo|ensureEngine|startHost|restartWorkspaceRuntime|reattachOrchestratorWorkspace|connectQuiet|engine_sse_|platform\.(?:engine|shell|storage))\b/g,
    message: "desktop/runtime command orchestration in the app layer",
  },
  {
    id: "authority-auth-policy",
    points: 8,
    cap: 4,
    pattern:
      /\b(auth|token|permission|policy|provider|gateway|managedAi|managedAI|admin|host_token|bearer|secret|authorization|role)\b/gi,
    message: "authority/auth/policy decision belongs near a server or runtime boundary",
  },
  {
    id: "server-owned-domain",
    points: 6,
    cap: 5,
    pattern:
      /\b(workspaceId|workspace registry|registry|conversation_run|conversationRun|transcript|lifecycle|queue|orchestrator|engine|runtime|daemon|route|mount|mcp|skill|plugin|materialization|opencodeSessionId|engineSessionId)\b/g,
    message: "server/runtime-owned domain state is being interpreted client-side",
  },
  {
    id: "durable-mutation",
    points: 6,
    cap: 4,
    pattern:
      /\b(create|update|delete|remove|write|persist|register|unregister|approve|deny|rename|archive|submit|abort|recover|reconcile|migrate|sync|materialize)\b/gi,
    message: "durable mutation or reconciliation logic in the app layer",
  },
  {
    id: "fallback-recovery",
    points: 7,
    cap: 4,
    pattern: /\b(fallback|legacy|recover|recovery|retry|reattach|reconnect|degraded|stale|sessionless|best[- ]effort|quiet)\b/gi,
    message: "fallback/recovery policy can easily drift from server truth",
  },
  {
    id: "contract-validation",
    points: 5,
    cap: 4,
    pattern: /\b(validate|schema|safeParse|parse|normalize|resolve[A-Z][A-Za-z0-9_]*Id|assert|invariant|statusCode|VesloServerError)\b/g,
    message: "contract validation or identity resolution in the app layer",
  },
  {
    id: "client-persistence",
    points: 7,
    cap: 3,
    pattern: /\b(localStorage|sessionStorage|indexedDB|makePersisted|persisted<|Persist\.|storage\??\.)\b/g,
    message: "client persistence can become an alternate source of truth",
  },
];

function numberArg(name, fallback) {
  const raw = process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

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

function lineStartsFor(contents) {
  const starts = [0];
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineForOffset(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (starts[mid] <= offset) low = mid + 1;
    else high = mid - 1;
  }
  return Math.max(1, high + 1);
}

function shouldSkipFunction(lines, index) {
  const start = Math.max(0, index - 3);
  return lines.slice(start, index + 1).some((line) => line.includes(IGNORE_MARKER));
}

function parseFunctionStart(lines, index) {
  const line = lines[index];
  const declaration = line.match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*[<(]/);
  if (declaration) return { name: declaration[1], kind: "function" };

  const arrow = line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b[^=]*=/);
  if (arrow) {
    const window = lines.slice(index, index + 12).join("\n");
    if (window.includes("=>")) return { name: arrow[1], kind: "arrow" };
  }

  return null;
}

function findOpeningBrace(contents, startOffset, maxOffset) {
  let sawArrow = false;
  let sawFunction = false;
  let state = "code";
  let quote = "";
  for (let index = startOffset; index < Math.min(contents.length, maxOffset); index += 1) {
    const char = contents[index];
    const next = contents[index + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state === "string") {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) state = "code";
      continue;
    }
    if (state === "template") {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === "`") state = "code";
      continue;
    }

    if (char === "/" && next === "/") {
      index += 1;
      state = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 1;
      state = "block-comment";
      continue;
    }
    if (char === "\"" || char === "'") {
      state = "string";
      quote = char;
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }
    if (contents.slice(index, index + 8) === "function") sawFunction = true;
    if (char === "=" && next === ">") sawArrow = true;
    if (char === "{") {
      if (sawFunction || sawArrow) return index;
      return -1;
    }
    if (char === ";" && !sawFunction) return -1;
  }
  return -1;
}

function findMatchingBrace(contents, openOffset) {
  let depth = 0;
  let state = "code";
  let quote = "";
  for (let index = openOffset; index < contents.length; index += 1) {
    const char = contents[index];
    const next = contents[index + 1];

    if (state === "line-comment") {
      if (char === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (char === "*" && next === "/") {
        index += 1;
        state = "code";
      }
      continue;
    }
    if (state === "string") {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) state = "code";
      continue;
    }
    if (state === "template") {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === "`") state = "code";
      continue;
    }

    if (char === "/" && next === "/") {
      index += 1;
      state = "line-comment";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 1;
      state = "block-comment";
      continue;
    }
    if (char === "\"" || char === "'") {
      state = "string";
      quote = char;
      continue;
    }
    if (char === "`") {
      state = "template";
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function collectFunctions(contents, relFile) {
  const lines = contents.split(/\r?\n/);
  const starts = lineStartsFor(contents);
  const functions = [];
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    if (shouldSkipFunction(lines, index)) continue;
    const parsed = parseFunctionStart(lines, index);
    if (!parsed) continue;

    const startOffset = starts[index];
    const maxOffset = starts[Math.min(starts.length - 1, index + 30)] ?? startOffset + 2000;
    const openOffset = findOpeningBrace(contents, startOffset, maxOffset);
    if (openOffset < 0) continue;
    const endOffset = findMatchingBrace(contents, openOffset);
    if (endOffset < 0) continue;

    const key = `${parsed.name}:${startOffset}:${endOffset}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const endLine = lineForOffset(starts, endOffset);
    functions.push({
      file: relFile,
      name: parsed.name,
      kind: parsed.kind,
      startLine: index + 1,
      endLine,
      text: contents.slice(startOffset, endOffset + 1),
    });
  }

  return functions;
}

function countMatches(text, pattern) {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(text)) count += 1;
  return count;
}

function estimateUiDiscount(fn) {
  let discount = 0;
  const path = fn.file;
  const text = fn.text;
  if (path.endsWith(".tsx")) discount += 4;
  if (/\/(components|pages)\//.test(path)) discount += 3;
  if (/^[A-Z]/.test(fn.name)) discount += 5;
  if (/<[A-Za-z][A-Za-z0-9]*(?:\s|>)/.test(text)) discount += 5;
  if (/\b(classList|class=|aria-|role=|onClick=|props\.)/.test(text)) discount += 3;
  if (/\b(createSignal|createMemo|createEffect|For|Show|Switch|Match|JSX)\b/.test(text)) discount += 2;
  return discount;
}

function complexitySignals(fn) {
  const text = fn.text;
  const lines = Math.max(1, fn.endLine - fn.startLine + 1);
  const branches = countMatches(text, /\b(if|else if|switch|case|\?|&&|\|\|)\b/g);
  const catches = countMatches(text, /\bcatch\s*(?:\(|\{)/g);
  const loops = countMatches(text, /\b(for|while|forEach|map|reduce|filter)\b/g);
  const asyncOps = countMatches(text, /\b(await|Promise\.|setTimeout|setInterval)\b/g);
  const signals = [];
  let points = 0;

  if (lines >= 120) {
    points += 12;
    signals.push({ id: "large-function", count: lines, points: 12, message: "large client-side decision surface" });
  } else if (lines >= 70) {
    points += 7;
    signals.push({ id: "large-function", count: lines, points: 7, message: "large client-side decision surface" });
  }

  if (branches >= 18) {
    points += 10;
    signals.push({ id: "branch-heavy", count: branches, points: 10, message: "many branches in app-side logic" });
  } else if (branches >= 10) {
    points += 5;
    signals.push({ id: "branch-heavy", count: branches, points: 5, message: "many branches in app-side logic" });
  }

  if (catches >= 2) {
    points += 7;
    signals.push({ id: "catch-heavy", count: catches, points: 7, message: "client-side error policy" });
  } else if (catches === 1) {
    points += 4;
    signals.push({ id: "catch-heavy", count: catches, points: 4, message: "client-side error policy" });
  }

  if (loops >= 5) {
    points += 4;
    signals.push({ id: "loop-heavy", count: loops, points: 4, message: "client-side collection reconciliation" });
  }

  if (asyncOps >= 4) {
    points += 4;
    signals.push({ id: "async-heavy", count: asyncOps, points: 4, message: "multi-step async workflow in app code" });
  }

  return { points, signals, metrics: { lines, branches, catches, loops, asyncOps } };
}

function scoreFunction(fn) {
  const signals = [];
  let rawScore = 0;

  for (const rule of signalRules) {
    const count = countMatches(fn.text, rule.pattern);
    if (count === 0) continue;
    const capped = Math.min(count, rule.cap);
    const points = capped * rule.points;
    rawScore += points;
    signals.push({ id: rule.id, count, points, message: rule.message });
  }

  const complexity = complexitySignals(fn);
  rawScore += complexity.points;
  signals.push(...complexity.signals);

  const uiDiscount = estimateUiDiscount(fn);
  const score = Math.max(0, rawScore - uiDiscount);
  const categoryIds = new Set(signals.map((signal) => signal.id));
  const hasBoundarySignal = ["server-request", "tauri-or-runtime-command", "authority-auth-policy", "server-owned-domain", "client-persistence"].some((id) =>
    categoryIds.has(id),
  );
  const hasPolicySignal = ["durable-mutation", "fallback-recovery", "contract-validation", "catch-heavy"].some((id) => categoryIds.has(id));
  const severity = score >= 100 && hasBoundarySignal && hasPolicySignal ? "high" : score >= 70 ? "medium" : "info";

  return {
    ...fn,
    score,
    rawScore,
    uiDiscount,
    severity,
    signals,
    metrics: complexity.metrics,
    include: showAll || (score >= minScore && hasBoundarySignal && signals.length >= 2),
  };
}

function severityWeight(severity) {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function conciseSignals(signals) {
  return signals
    .sort((left, right) => right.points - left.points || left.id.localeCompare(right.id))
    .slice(0, 5)
    .map((signal) => `${signal.id}:${signal.count}`)
    .join(", ");
}

function printHumanReport(report) {
  console.log("Client logic audit");
  console.log(`scanned roots: ${SCAN_ROOTS.join(", ")}`);
  console.log(
    `scanned ${report.scannedFiles} files and ${report.scannedFunctions} functions. Findings: ${report.findings.length}. min-score=${minScore}`,
  );
  console.log("Heuristic monitor only: findings mark app-side functions worth reviewing for server/runtime ownership.");
  console.log(`Use ${IGNORE_MARKER} near a function only after an explicit ownership decision.`);

  if (report.findings.length === 0) {
    console.log("\nNo client-owned logic hotspots crossed the current threshold.");
    return;
  }

  console.log("\nseverity  score  raw  ui  lines  branches  catches  async  function");
  for (const finding of report.findings.slice(0, maxRows)) {
    console.log(
      `${finding.severity.padEnd(8)}  ${String(finding.score).padStart(5)}  ${String(finding.rawScore).padStart(3)}  ${String(finding.uiDiscount).padStart(2)}  ${String(finding.metrics.lines).padStart(5)}  ${String(finding.metrics.branches).padStart(8)}  ${String(finding.metrics.catches).padStart(7)}  ${String(finding.metrics.asyncOps).padStart(5)}  ${finding.file}:${finding.startLine} ${finding.name}`,
    );
    console.log(`  signals: ${conciseSignals(finding.signals)}`);
  }

  if (report.findings.length > maxRows) console.log(`\n... ${report.findings.length - maxRows} more`);
}

const files = [];
for (const root of SCAN_ROOTS) await walk(resolve(repoRoot, root), files);

const scored = [];
let scannedFunctions = 0;
for (const file of files) {
  if (isTestPath(file)) continue;
  const relFile = normalizePath(file);
  const contents = await readFile(file, "utf8");
  for (const fn of collectFunctions(contents, relFile)) {
    scannedFunctions += 1;
    const scoredFunction = scoreFunction(fn);
    if (scoredFunction.include) scored.push(scoredFunction);
  }
}

scored.sort(
  (left, right) =>
    severityWeight(right.severity) - severityWeight(left.severity) ||
    right.score - left.score ||
    right.rawScore - left.rawScore ||
    left.file.localeCompare(right.file) ||
    left.startLine - right.startLine,
);

const report = {
  ok: !strict || !scored.some((finding) => finding.severity === "high"),
  strict,
  minScore,
  scannedFiles: files.filter((file) => !isTestPath(file)).length,
  scannedFunctions,
  findings: scored.map((finding) => ({
    severity: finding.severity,
    score: finding.score,
    rawScore: finding.rawScore,
    uiDiscount: finding.uiDiscount,
    file: finding.file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    name: finding.name,
    kind: finding.kind,
    metrics: finding.metrics,
    signals: finding.signals,
  })),
};

if (json) console.log(JSON.stringify(report, null, 2));
else printHumanReport(report);

if (!report.ok) {
  if (!json) console.error("\nClient logic audit failed in --strict mode because high-severity hotspots exist.");
  process.exit(1);
}

if (!json) console.log("\nClient logic audit completed.");
