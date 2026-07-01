import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const contextDirUrl = new URL("../../context/", import.meta.url);
const testsDir = fileURLToPath(new URL("../", import.meta.url));
const sessionSourceUrl = new URL("../../context/session.ts", import.meta.url);

const allowedSessionContextModules = new Set([
  "session.ts",
  "session-reconnect.ts",
  "session-store-model.ts",
  "session-transcript-controller.ts",
  "session-runtime-prompts.ts",
  "session-selection-controller.ts",
  "session-event-stream.ts",
  "session-workspace-cache.ts",
  "session-archive-store.ts",
  "session-lifecycle-recovery.ts",
  "session-route-sync.ts",
]);

const plannedExtractedModules = [
  "session-store-model.ts",
  "session-transcript-controller.ts",
  "session-runtime-prompts.ts",
  "session-selection-controller.ts",
  "session-event-stream.ts",
  "session-workspace-cache.ts",
  "session-archive-store.ts",
  "session-lifecycle-recovery.ts",
  "session-route-sync.ts",
];

const expectedContextSessionSourceReaders = [
  "context/session-reconnect-store.test.ts",
  "context/session-unread-events.test.ts",
  "context/session-workspace-busy-source.test.ts",
];

function productionSessionContextModules() {
  return readdirSync(contextDirUrl)
    .filter((name) => /^session(?:-|\.ts$)/.test(name))
    .filter((name) => /\.(?:ts|tsx)$/.test(name))
    .filter((name) => !name.endsWith(".test.ts"));
}

function nonBlankLineCount(source: string) {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .length;
}

function allTestFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = `${dir}${sep}${entry}`;
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...allTestFiles(path));
    } else if (/\.test\.ts$/.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function relativeTestPath(path: string) {
  return relative(testsDir, path).replace(/\\/g, "/");
}

test("session context remains the public store facade", () => {
  const source = readFileSync(sessionSourceUrl, "utf8");

  assert.match(
    source,
    /export type SessionStore = ReturnType<typeof createSessionStore>;/,
    "SessionStore should remain exported from the public session context facade",
  );
  assert.match(
    source,
    /export function createSessionStore\(options: \{/,
    "createSessionStore should remain the stable public store factory during modularization",
  );
});

test("session context modularization uses planned durable context module boundaries", () => {
  const relevantModules = productionSessionContextModules();
  const unplannedModules = relevantModules.filter((name) => !allowedSessionContextModules.has(name));

  assert.deepEqual(
    unplannedModules,
    [],
    "new session context modules should be added to the implementation plan instead of creating ad hoc tiny files",
  );
});

test("planned session context modules are substantial and do not import the facade", () => {
  const violations: string[] = [];

  for (const moduleName of plannedExtractedModules) {
    const moduleUrl = new URL(`../../context/${moduleName}`, import.meta.url);
    if (!existsSync(moduleUrl)) continue;

    const source = readFileSync(moduleUrl, "utf8");
    if (nonBlankLineCount(source) < 80) {
      violations.push(`${moduleName}: fewer than 80 non-blank lines`);
    }
    if (/from\s+["']\.\/session["']|from\s+["']\.\.\/context\/session["']/.test(source)) {
      violations.push(`${moduleName}: imports from session.ts facade`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    "extracted context modules should own durable behavior and must not depend on the session facade",
  );
});

test("direct context/session.ts source readers are inventoried before extraction", () => {
  const directReaders = allTestFiles(testsDir)
    .filter((path) => readFileSync(path, "utf8").includes("context/session.ts"))
    .map(relativeTestPath)
    .filter((path) => path !== "context/session-context-modularization.test.ts")
    .sort();

  assert.deepEqual(
    directReaders,
    expectedContextSessionSourceReaders,
    "tests that read context/session.ts directly should be deliberately retargeted phase by phase",
  );
});
