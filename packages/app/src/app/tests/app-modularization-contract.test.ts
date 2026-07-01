import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

type PlannedAppModule = {
  id: string;
  relativePath: string;
  owner: "context" | "page-workflow" | "app-props";
  minimumImplementationLines?: number;
};

type SourceContractClassification = "behavior" | "wiring" | "placement";

type AppSourceContractInventoryEntry = {
  path: string;
  classification: SourceContractClassification;
  retargetBy: string;
};

const testsDir = fileURLToPath(new URL(".", import.meta.url));

const plannedAppModules: PlannedAppModule[] = [
  { id: "AM01", relativePath: "context/app-shell-environment.ts", owner: "context" },
  { id: "AM02", relativePath: "context/app-route-sync.ts", owner: "context" },
  { id: "AM03", relativePath: "context/feedback-workflow.ts", owner: "context" },
  { id: "AM04", relativePath: "context/veslo-server-connection.ts", owner: "context" },
  { id: "AM05", relativePath: "context/workspace-runtime-debug-probe.ts", owner: "context" },
  { id: "AM06", relativePath: "context/den-desktop-auth-workflow.ts", owner: "context" },
  { id: "AM07", relativePath: "context/managed-ai-access-store.ts", owner: "context" },
  { id: "AM08", relativePath: "context/managed-ai-runtime-config.ts", owner: "context" },
  { id: "AM09", relativePath: "context/conversation-service.ts", owner: "context" },
  { id: "AM10", relativePath: "pages/session-attachment-staging.ts", owner: "page-workflow" },
  { id: "AM11", relativePath: "pages/session-send-workflow.ts", owner: "page-workflow" },
  { id: "AM12", relativePath: "pages/session-creation-workflow.ts", owner: "page-workflow" },
  { id: "AM13", relativePath: "pages/session-mutation-workflow.ts", owner: "page-workflow" },
  { id: "AM14", relativePath: "context/session-archive-store.ts", owner: "context" },
  { id: "AM15", relativePath: "context/session-sidebar-decorations.ts", owner: "context" },
  { id: "AM16", relativePath: "context/session-route-sync.ts", owner: "context" },
  { id: "AM17", relativePath: "context/session-capabilities-store.ts", owner: "context" },
  { id: "AM18", relativePath: "context/app-deep-link-workflow.ts", owner: "context" },
  { id: "AM19", relativePath: "context/skill-registry-orchestrator.ts", owner: "context" },
  { id: "AM20", relativePath: "context/mcp-connection-workflow.ts", owner: "context" },
  { id: "AM21", relativePath: "pages/scheduled-automation-store.ts", owner: "page-workflow" },
  { id: "AM22", relativePath: "pages/soul-data-store.ts", owner: "page-workflow" },
  { id: "AM23", relativePath: "context/app-startup-hydration.ts", owner: "context" },
  { id: "AM24", relativePath: "app-view-props.ts", owner: "app-props", minimumImplementationLines: 100 },
];

const appSourceContractInventory: AppSourceContractInventoryEntry[] = [
  { path: "app-attachment-workspace-readiness.test.ts", classification: "behavior", retargetBy: "AM10" },
  { path: "app-boot-engine-ready.test.ts", classification: "behavior", retargetBy: "AM23/AM08" },
  { path: "app-conversation-abort.test.ts", classification: "behavior", retargetBy: "AM09" },
  { path: "app-create-session-health-fallback.test.ts", classification: "behavior", retargetBy: "AM04" },
  { path: "app-feedback-flow.contract.test.ts", classification: "behavior", retargetBy: "AM03" },
  { path: "app-local-veslo-server-ensure.test.ts", classification: "behavior", retargetBy: "AM04" },
  { path: "app-managed-ai-bootstrap-gate.test.ts", classification: "behavior", retargetBy: "AM07" },
  { path: "app-managed-ai-config-sync-contract.test.ts", classification: "wiring", retargetBy: "AM08" },
  { path: "app-managed-ai-runtime-controller-contract.test.ts", classification: "wiring", retargetBy: "AM07/AM08" },
  { path: "app-overlay-i18n.test.ts", classification: "wiring", retargetBy: "AM01" },
  { path: "app-pending-draft-startup-contract.test.ts", classification: "behavior", retargetBy: "AM23" },
  { path: "app-pending-session-draft-controller.test.ts", classification: "wiring", retargetBy: "AM12/AM23" },
  { path: "app-refactor-contracts.test.ts", classification: "wiring", retargetBy: "AM02/AM18/AM23" },
  { path: "app-send-latency-trace.test.ts", classification: "behavior", retargetBy: "AM11" },
  { path: "app-send-orchestration-controller-contract.test.ts", classification: "wiring", retargetBy: "AM11" },
  { path: "app-send-preflight-context.test.ts", classification: "behavior", retargetBy: "AM11" },
  { path: "app-send-workspace-scope.test.ts", classification: "behavior", retargetBy: "AM11" },
  { path: "app-session-archives.test.ts", classification: "behavior", retargetBy: "AM14/AM23" },
  { path: "app-session-creation-flow-contract.test.ts", classification: "wiring", retargetBy: "AM12" },
  { path: "app-session-prompt-error.test.ts", classification: "behavior", retargetBy: "AM13" },
  { path: "app-session-route-controller-contract.test.ts", classification: "wiring", retargetBy: "AM16" },
  { path: "app-skill-registry-events.test.ts", classification: "behavior", retargetBy: "AM19" },
  { path: "app-startup-route-controller-contract.test.ts", classification: "wiring", retargetBy: "AM02" },
  { path: "app-startup-signal-order.test.ts", classification: "placement", retargetBy: "AM23" },
  { path: "app-unread-session-indicator.test.ts", classification: "behavior", retargetBy: "AM13" },
  { path: "app-updater-retry-scheduling.test.ts", classification: "behavior", retargetBy: "AM23" },
  { path: "app-view-props.test.ts", classification: "wiring", retargetBy: "AM24" },
  { path: "app-veslo-server-state-stability.test.ts", classification: "behavior", retargetBy: "AM04" },
  { path: "components/session/composer-docx-delegation.test.ts", classification: "behavior", retargetBy: "AM10" },
  { path: "context/session-switch-metrics.test.ts", classification: "behavior", retargetBy: "AM11/AM16" },
  { path: "context/session-transcript-hydration.test.ts", classification: "behavior", retargetBy: "AM09" },
  { path: "context/app-startup-hydration.test.ts", classification: "wiring", retargetBy: "AM23" },
  { path: "context/session-workspace-busy-source.test.ts", classification: "wiring", retargetBy: "AM05" },
  { path: "context/workspace-activate-order-sync.test.ts", classification: "wiring", retargetBy: "AM23" },
  { path: "context/workspace-session-snapshots.test.ts", classification: "wiring", retargetBy: "AM09/AM17" },
  { path: "context/workspace-switch-overlay-state.test.ts", classification: "wiring", retargetBy: "AM23" },
  { path: "lib/session-route-selection-guard.test.ts", classification: "wiring", retargetBy: "AM16" },
  { path: "mcp-hub-contract.test.ts", classification: "wiring", retargetBy: "AM20" },
  { path: "pages/dashboard-menu-navigation.test.ts", classification: "wiring", retargetBy: "AM24" },
  { path: "pages/session-inline-loading.test.ts", classification: "wiring", retargetBy: "AM24" },
  { path: "pages/session-message-queue.test.ts", classification: "behavior", retargetBy: "AM11" },
  { path: "pages/session-message-replacement.test.ts", classification: "behavior", retargetBy: "AM13" },
  { path: "pages/session-mutation-workspace-routing.test.ts", classification: "behavior", retargetBy: "AM13" },
  { path: "pages/session-navigation.test.ts", classification: "wiring", retargetBy: "AM16/AM24" },
  { path: "pages/session-pending-sidebar-cleanup.test.ts", classification: "behavior", retargetBy: "AM11" },
  { path: "pages/session-view-modularization.test.ts", classification: "placement", retargetBy: "AM24/AM25" },
  { path: "pages/settings-tabs-layout.test.ts", classification: "wiring", retargetBy: "AM24" },
  { path: "pages/sidebar-update-prompt-actions.test.ts", classification: "wiring", retargetBy: "AM13/AM24" },
  { path: "pages/skills-layout-contract.test.ts", classification: "wiring", retargetBy: "AM20/AM24" },
  { path: "session-list-roots-regression.test.ts", classification: "placement", retargetBy: "AM14" },
  { path: "session-route-client-resume.test.ts", classification: "behavior", retargetBy: "AM16" },
  { path: "subagent-role-classifier-session-regression.test.ts", classification: "behavior", retargetBy: "AM15" },
];

function moduleUrl(module: PlannedAppModule): URL {
  return new URL(`../${module.relativePath}`, import.meta.url);
}

function implementationLineCount(source: string): number {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("//"))
    .filter((line) => !line.startsWith("*"))
    .filter((line) => line !== "/*" && line !== "*/")
    .length;
}

function moduleContractViolations(module: PlannedAppModule, source: string): string[] {
  const violations: string[] = [];
  const minimumImplementationLines = module.minimumImplementationLines ?? 120;

  if (implementationLineCount(source) < minimumImplementationLines) {
    violations.push(`${module.id} ${module.relativePath}: fewer than ${minimumImplementationLines} implementation lines`);
  }
  if (/from\s+["'](?:\.{1,2}\/)*app(?:\.tsx)?["']/.test(source)) {
    violations.push(`${module.id} ${module.relativePath}: imports app.tsx instead of receiving dependencies`);
  }
  if (!/\bexport\s+(?:async\s+)?function\s+(?:create|build|resolve|use)[A-Z]\w+/.test(source)) {
    violations.push(`${module.id} ${module.relativePath}: missing exported create/build/resolve/use boundary`);
  }

  return violations;
}

function substantialFactorySource(name: string, lineCount: number): string {
  const lines = [`export function ${name}(deps: Record<string, unknown>) {`];

  for (let index = 0; index < lineCount; index += 1) {
    lines.push(`  const value${index} = deps["value${index}"];`);
  }
  lines.push("  return { deps };");
  lines.push("}");

  return lines.join("\n");
}

function findTestFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findTestFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      files.push(path);
    }
  }

  return files;
}

function relativeTestPath(path: string): string {
  return relative(testsDir, path).split(sep).join("/");
}

test("planned app extraction modules stay inside durable owner boundaries", () => {
  const violations = plannedAppModules.flatMap((module) => {
    if (module.owner === "context" && !module.relativePath.startsWith("context/")) {
      return [`${module.id} should live under context/`];
    }
    if (module.owner === "page-workflow" && !module.relativePath.startsWith("pages/")) {
      return [`${module.id} should live under pages/`];
    }
    if (module.owner === "app-props" && module.relativePath !== "app-view-props.ts") {
      return [`${module.id} should be the app view prop adapter`];
    }
    return [];
  });

  assert.deepEqual(violations, [], "planned app modules should stay inside the directories approved by the plan");
  assert.equal(new Set(plannedAppModules.map((module) => module.id)).size, 24, "AM01-AM24 should each have one target module");
});

test("modularization guard rejects tiny wrappers", () => {
  const wrapper = "export function createAppShellEnvironment(deps: unknown) {\n  return deps;\n}\n";
  const violations = moduleContractViolations(plannedAppModules[0], wrapper);

  assert.ok(
    violations.some((violation) => violation.includes("fewer than 120 implementation lines")),
    "a wrapper-sized extraction should fail the module size guard",
  );
});

test("modularization guard allows substantial context and page workflow modules", () => {
  assert.deepEqual(
    moduleContractViolations(plannedAppModules[0], substantialFactorySource("createAppShellEnvironment", 120)),
    [],
    "a context module with a real factory boundary should satisfy the baseline guard",
  );
  assert.deepEqual(
    moduleContractViolations(plannedAppModules[10], substantialFactorySource("createSessionSendWorkflow", 120)),
    [],
    "a page workflow module with a real factory boundary should satisfy the baseline guard",
  );
});

test("planned app extraction modules are substantial once they exist", () => {
  const violations: string[] = [];

  for (const module of plannedAppModules) {
    const url = moduleUrl(module);
    if (!existsSync(url)) continue;

    violations.push(...moduleContractViolations(module, readFileSync(url, "utf8")));
  }

  assert.deepEqual(
    violations,
    [],
    "new app.tsx extraction modules should own a durable boundary instead of becoming pass-through wrappers",
  );
});

test("app.tsx source-contract readers are classified for later retargeting", () => {
  const inventory = new Map(appSourceContractInventory.map((entry) => [entry.path, entry]));
  const appSourceReaders = findTestFiles(testsDir)
    .map((path) => ({ path: relativeTestPath(path), source: readFileSync(path, "utf8") }))
    .filter((entry) => entry.path !== "app-modularization-contract.test.ts")
    .filter((entry) => entry.source.includes("app.tsx"))
    .map((entry) => entry.path)
    .sort();
  const unclassifiedReaders = appSourceReaders.filter((path) => !inventory.has(path));
  const staleInventory = [...inventory.keys()]
    .filter((path) => existsSync(join(testsDir, path)))
    .filter((path) => !appSourceReaders.includes(path));
  const missingFiles = [...inventory.keys()].filter((path) => !existsSync(join(testsDir, path)));

  assert.deepEqual(unclassifiedReaders, [], "new app.tsx source readers should be classified before extraction work proceeds");
  assert.deepEqual(staleInventory, [], "retargeted app.tsx source readers should be removed from the baseline inventory");
  assert.deepEqual(missingFiles, [], "inventory entries should point to existing tests");
  assert.ok(
    appSourceContractInventory.some((entry) => entry.classification === "placement"),
    "inventory should keep brittle placement contracts visible for retargeting",
  );
});
