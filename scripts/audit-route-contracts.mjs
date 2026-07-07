import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const SKIP_DIRS = new Set([".git", ".turbo", "coverage", "dist", "gen", "node_modules", "target"]);
const SERVER_ROUTE_ROOTS = ["packages/server/src"];
const CLIENT_PATH_ROOTS = [
  "packages/app/src/app/lib/veslo-server",
  "packages/app/src/app/lib/veslo-server-domains",
  "packages/app/src/app/context",
];

const SERVER_PATH_PREFIXES = [
  "/ai-gateway",
  "/approvals",
  "/capabilities",
  "/document-runtime",
  "/files",
  "/health",
  "/hub",
  "/session-archives",
  "/skill-removals",
  "/skills",
  "/soul",
  "/status",
  "/tokens",
  "/ui",
  "/v1",
  "/w",
  "/whoami",
  "/workspace",
  "/workspaces",
];

const addRoutePattern =
  /addRoute\s*\(\s*routes\s*,\s*["']([A-Z]+)["']\s*,\s*["']([^"']+)["']\s*,\s*["']([^"']+)["']/g;
const stringPattern = /(["'`])((?:\/(?:ai-gateway|approvals|capabilities|document-runtime|files|health|hub|session-archives|skill-removals|skills|soul|status|tokens|ui|v1|w|whoami|workspace|workspaces)\b|\/)[^"'`]*)\1/g;

function normalizePath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function lineFor(contents, index) {
  return contents.slice(0, index).split(/\r?\n/).length;
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

function stripQueryAndHash(path) {
  return path.split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/";
}

function routeShape(path) {
  return stripQueryAndHash(path)
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (segment.startsWith(":")) return ":";
      return segment;
    })
    .join("/");
}

function clientShape(path) {
  return stripQueryAndHash(path)
    .replace(/\$\{[^}]+\}/g, ":")
    .replace(/encodeURIComponent\([^)]*\)/g, ":")
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (segment === ":" || segment.includes(":")) return ":";
      return segment;
    })
    .join("/");
}

function startsWithServerPrefix(path) {
  return SERVER_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function balancedTemplateExpression(path) {
  const opens = path.match(/\$\{/g)?.length ?? 0;
  const closes = path.match(/\}/g)?.length ?? 0;
  return opens === closes;
}

async function readRoutes() {
  const files = [];
  for (const root of SERVER_ROUTE_ROOTS) await walk(resolve(repoRoot, root), files);
  const routes = [];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    addRoutePattern.lastIndex = 0;
    let match;
    while ((match = addRoutePattern.exec(contents))) {
      routes.push({
        method: match[1],
        path: match[2],
        auth: match[3],
        shape: routeShape(match[2]),
        file: normalizePath(file),
        line: lineFor(contents, match.index),
      });
    }
  }
  return routes;
}

async function readClientPaths() {
  const files = [];
  for (const root of CLIENT_PATH_ROOTS) await walk(resolve(repoRoot, root), files);
  const paths = [];
  for (const file of files) {
    const contents = await readFile(file, "utf8");
    stringPattern.lastIndex = 0;
    let match;
    while ((match = stringPattern.exec(contents))) {
      const rawPath = match[2];
      if (!balancedTemplateExpression(rawPath)) continue;
      if (!startsWithServerPrefix(stripQueryAndHash(rawPath))) continue;
      paths.push({
        path: rawPath,
        shape: clientShape(rawPath),
        file: normalizePath(file),
        line: lineFor(contents, match.index),
      });
    }
  }
  return paths;
}

const routes = await readRoutes();
const clientPaths = await readClientPaths();
const routesByMethodAndPath = new Map();
const routesByShape = new Map();
const errors = [];

for (const route of routes) {
  const key = `${route.method} ${route.path}`;
  const existing = routesByMethodAndPath.get(key);
  if (existing) {
    errors.push(`Duplicate route ${key}: ${existing.file}:${existing.line} and ${route.file}:${route.line}`);
  } else {
    routesByMethodAndPath.set(key, route);
  }

  const byShape = routesByShape.get(route.shape) ?? [];
  byShape.push(route);
  routesByShape.set(route.shape, byShape);
}

const clientByShape = new Map();
for (const clientPath of clientPaths) {
  const byShape = clientByShape.get(clientPath.shape) ?? [];
  byShape.push(clientPath);
  clientByShape.set(clientPath.shape, byShape);
}

const unmatchedClientPaths = clientPaths
  .filter((clientPath) => !routesByShape.has(clientPath.shape))
  .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

const unmatchedRoutes = routes
  .filter((route) => !clientByShape.has(route.shape))
  .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

console.log(`Route contract audit scanned ${routes.length} server routes and ${clientPaths.length} client path strings.`);

if (errors.length > 0) {
  console.error("\nHard route contract violations:\n");
  for (const error of errors) console.error(`ERROR ${error}`);
}

if (unmatchedClientPaths.length > 0) {
  console.log(`\nClient path strings without a matching registered server route shape: ${unmatchedClientPaths.length}`);
  for (const item of unmatchedClientPaths.slice(0, 40)) {
    console.log(`WARN ${item.file}:${item.line} ${item.path}`);
  }
  if (unmatchedClientPaths.length > 40) {
    console.log(`... ${unmatchedClientPaths.length - 40} more`);
  }
}

if (unmatchedRoutes.length > 0) {
  console.log(`\nRegistered server routes without a known app/test path string shape: ${unmatchedRoutes.length}`);
  for (const route of unmatchedRoutes.slice(0, 40)) {
    console.log(`INFO ${route.file}:${route.line} ${route.method} ${route.path} (${route.auth})`);
  }
  if (unmatchedRoutes.length > 40) {
    console.log(`... ${unmatchedRoutes.length - 40} more`);
  }
}

if (errors.length > 0) process.exit(1);
console.log("\nRoute contract hard checks passed.");
