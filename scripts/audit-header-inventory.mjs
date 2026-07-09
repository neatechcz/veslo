import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const showAll = process.argv.includes("--all");
const variantsOnly = process.argv.includes("--variants");
const includeTests = process.argv.includes("--include-tests");
const includeE2e = process.argv.includes("--include-e2e");
const json = process.argv.includes("--json");
const minCountArg = process.argv.find((arg) => arg.startsWith("--min-count="));
const minCount = Number(minCountArg?.slice("--min-count=".length) ?? 2);

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs", ".yml", ".yaml"]);
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
  "third_party",
]);
const SCAN_ROOTS = [
  ".github/workflows",
  "packages/app/src/app",
  "packages/server/src",
  "packages/orchestrator/src",
  "packages/desktop/src-tauri/src",
  "packages/web",
  "services/ai-gateway/src",
  "services/den/src",
  "services/openwork-share/api",
  "services/worker-manager/src",
  "scripts",
  ...(includeE2e ? ["packages/e2e"] : []),
];
const SELF_AUDIT_FILES = new Set([
  "scripts/audit-header-inventory.mjs",
  "scripts/audit-veslo-headers.mjs",
]);

const STANDARD_HEADERS = new Set([
  "accept",
  "accept-encoding",
  "authorization",
  "cache-control",
  "connection",
  "content-disposition",
  "content-encoding",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "keep-alive",
  "origin",
  "referer",
  "set-cookie",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "user-agent",
  "vary",
]);
const CUSTOM_HEADER_PREFIXES = [
  "access-control-",
  "x-api-",
  "x-content-",
  "x-forwarded-",
  "x-github-",
  "x-opencode-",
  "x-powered-",
  "x-request-",
  "x-session-",
  "x-veslo-",
];
const CUSTOM_HEADER_NAMES = new Set([
  "x-api-key",
  "x-openai-client-user-agent",
]);
const AMBIGUOUS_STANDARD_HEADERS = new Set([
  "accept",
  "authorization",
  "connection",
  "cookie",
  "host",
  "origin",
  "referer",
  "te",
  "trailer",
  "trailers",
  "upgrade",
  "vary",
]);
const STRING_LITERAL_PATTERN =
  /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
const HEADER_PROPERTY_PATTERN = /\bheaders\.([A-Za-z][A-Za-z0-9]*)\b/g;
const BARE_STANDARD_HEADER_PATTERN = /\b(Authorization|Accept|Origin|Host|Vary|Cookie|Referer)\s*:/g;
const HEADER_CONTEXT_PATTERN =
  /\b(headers?|setHeader|req\.header|req\.get|requestHeader|Headers|Access-Control|curl_headers|response\.headers|request\.headers)\b|-H\s/;

function normalizePath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function isTestPath(normalizedPath) {
  return /(^|\/)(tests?|__tests__)\//.test(normalizedPath) ||
    /\.(test|spec)\.[cm]?[tj]sx?$/.test(normalizedPath);
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

function canonicalHeaderName(value) {
  return value.trim().toLowerCase();
}

function isKnownHeaderName(value) {
  const canonical = canonicalHeaderName(value);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(canonical)) return false;
  if (STANDARD_HEADERS.has(canonical) || CUSTOM_HEADER_NAMES.has(canonical)) return true;
  return CUSTOM_HEADER_PREFIXES.some((prefix) => canonical.startsWith(prefix));
}

function headerNameFromColonLiteral(value) {
  const colonIndex = value.indexOf(":");
  if (colonIndex < 1) return null;
  const candidate = value.slice(0, colonIndex).trim();
  return isKnownHeaderName(candidate) ? candidate : null;
}

function headerNamesFromLiteral(value) {
  const trimmed = value.trim();
  if (!trimmed) return [];

  const colonHeader = headerNameFromColonLiteral(trimmed);
  if (colonHeader) return [colonHeader];

  if (trimmed.includes(",")) {
    const parts = trimmed.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every(isKnownHeaderName)) return parts;
    return [];
  }

  return isKnownHeaderName(trimmed) ? [trimmed] : [];
}

function addEntry(map, input) {
  const canonical = canonicalHeaderName(input.name);
  const row = map.get(canonical) ?? {
    canonical,
    count: 0,
    variants: new Map(),
    files: new Map(),
    entries: [],
  };
  row.count += 1;
  row.variants.set(input.name, (row.variants.get(input.name) ?? 0) + 1);
  const fileLines = row.files.get(input.file) ?? new Set();
  fileLines.add(input.line);
  row.files.set(input.file, fileLines);
  if (row.entries.length < 40) {
    row.entries.push(input);
  }
  map.set(canonical, row);
}

function serializableRow(row) {
  return {
    canonical: row.canonical,
    count: row.count,
    variants: Object.fromEntries([...row.variants.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    files: [...row.files.entries()]
      .map(([file, lines]) => ({ file, lines: [...lines].sort((a, b) => a - b).slice(0, 10) }))
      .sort((left, right) => left.file.localeCompare(right.file)),
    entries: showAll ? row.entries : undefined,
  };
}

const files = [];
for (const root of SCAN_ROOTS) await walk(resolve(repoRoot, root), files);

const headers = new Map();
for (const filePath of files) {
  const file = normalizePath(filePath);
  if (SELF_AUDIT_FILES.has(file)) continue;
  if (!includeTests && isTestPath(file)) continue;

  const contents = await readFile(filePath, "utf8");
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;
    const hasHeaderContext = HEADER_CONTEXT_PATTERN.test(line);

    STRING_LITERAL_PATTERN.lastIndex = 0;
    let literalMatch;
    while ((literalMatch = STRING_LITERAL_PATTERN.exec(line))) {
      const literal = literalMatch[1] ?? literalMatch[2] ?? literalMatch[3] ?? "";
      const names = headerNamesFromLiteral(literal).filter((name) => {
        const canonical = canonicalHeaderName(name);
        return hasHeaderContext || !AMBIGUOUS_STANDARD_HEADERS.has(canonical);
      });
      if (names.length === 0) continue;
      if (!hasHeaderContext && names.every((name) => canonicalHeaderName(name).startsWith("x-"))) {
        continue;
      }
      for (const name of names) {
        addEntry(headers, { name, file, line: lineNumber, source: "literal", literal });
      }
    }

    HEADER_PROPERTY_PATTERN.lastIndex = 0;
    let propertyMatch;
    while ((propertyMatch = HEADER_PROPERTY_PATTERN.exec(line))) {
      const property = propertyMatch[1];
      if (["append", "delete", "entries", "forEach", "get", "has", "keys", "set", "values"].includes(property)) {
        continue;
      }
      if (isKnownHeaderName(property)) {
        addEntry(headers, { name: property, file, line: lineNumber, source: "headers-property", literal: property });
      }
    }

    BARE_STANDARD_HEADER_PATTERN.lastIndex = 0;
    let bareMatch;
    while (hasHeaderContext && (bareMatch = BARE_STANDARD_HEADER_PATTERN.exec(line))) {
      addEntry(headers, { name: bareMatch[1], file, line: lineNumber, source: "bare-property", literal: bareMatch[1] });
    }
  }
}

const rows = [...headers.values()].sort(
  (left, right) => right.count - left.count || left.canonical.localeCompare(right.canonical),
);
const variantRows = rows.filter((row) => row.variants.size > 1);
const reportRows = variantsOnly ? variantRows : rows.filter((row) => row.count >= minCount || row.variants.size > 1);

if (json) {
  process.stdout.write(JSON.stringify({
    scannedFiles: files.length,
    headerNames: rows.length,
    entries: rows.reduce((total, row) => total + row.count, 0),
    variants: variantRows.map(serializableRow),
    headers: reportRows.map(serializableRow),
  }, null, 2));
  process.stdout.write("\n");
} else {
  console.log(
    `Header inventory scanned ${files.length} files. Header names: ${rows.length}. Entries: ${rows.reduce((total, row) => total + row.count, 0)}. Variants: ${variantRows.length}.`,
  );
  console.log(`Tests: ${includeTests ? "included" : "excluded"}. E2E: ${includeE2e ? "included" : "excluded"}.`);

  if (variantRows.length > 0) {
    console.log("\nCasing / spelling variants:");
    for (const row of variantRows) {
      const variants = [...row.variants.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([variant, count]) => `${variant}=${count}`)
        .join(", ");
      console.log(`WARN ${row.canonical} (${row.count}) ${variants}`);
    }
  }

  if (!variantsOnly) {
    console.log(`\nHeader names with count >= ${minCount}:`);
    for (const row of reportRows.slice(0, showAll ? reportRows.length : 80)) {
      const filesSummary = [...row.files.keys()].slice(0, 3).join(", ");
      console.log(`${String(row.count).padStart(4)} ${row.canonical} [${[...row.variants.keys()].join(" | ")}] ${filesSummary}`);
    }
    if (!showAll && reportRows.length > 80) console.log(`... ${reportRows.length - 80} more`);
  }
}
