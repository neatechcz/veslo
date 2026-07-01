import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const pagesDirUrl = new URL("../../pages/", import.meta.url);
const sessionSourceUrl = new URL("../../pages/session.tsx", import.meta.url);
const conversationFlowSourceUrl = new URL("../../pages/session-conversation-flow.ts", import.meta.url);
const leftSidebarSourceUrl = new URL("../../pages/session-left-sidebar.tsx", import.meta.url);
const rightSidebarSourceUrl = new URL("../../pages/session-right-sidebar.tsx", import.meta.url);
const centerSourceUrl = new URL("../../pages/session-center.tsx", import.meta.url);

const allowedSessionPageModules = new Set([
  "session.tsx",
  "session-composer-drafts.ts",
  "session-layout-width.ts",
  "session-navigation.ts",
  "session-shortcuts.ts",
  "session-titlebar-context.ts",
  "session-conversation-flow.ts",
  "session-transcript-viewport.ts",
  "session-search-command-controller.ts",
  "session-attachment-staging.ts",
  "session-mutation-workflow.ts",
  "session-left-sidebar.tsx",
  "session-right-sidebar.tsx",
  "session-center.tsx",
  "workspace-share-controller.ts",
]);

const plannedExtractedModules = [
  "session-conversation-flow.ts",
  "session-transcript-viewport.ts",
  "session-search-command-controller.ts",
  "session-attachment-staging.ts",
  "session-mutation-workflow.ts",
  "session-left-sidebar.tsx",
  "session-right-sidebar.tsx",
  "session-center.tsx",
  "workspace-share-controller.ts",
];

const minimumExtractedModuleLineCounts = new Map<string, number>([
  ["session-center.tsx", 60],
]);

function productionPageModules() {
  return readdirSync(pagesDirUrl)
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

test("session view remains the public page integration entry point", () => {
  const source = readFileSync(sessionSourceUrl, "utf8");

  assert.match(
    source,
    /export type SessionViewProps = \{/,
    "SessionViewProps should remain exported from the public session page during the first modularization pass",
  );
  assert.match(
    source,
    /export default function SessionView\(props: SessionViewProps\)/,
    "SessionView should remain the stable default export consumed by app.tsx",
  );
});

test("session page modularization uses planned durable page module boundaries", () => {
  const relevantPageModules = productionPageModules().filter(
    (name) => name === "session.tsx" || name.startsWith("session-") || name === "workspace-share-controller.ts",
  );
  const unplannedModules = relevantPageModules.filter((name) => !allowedSessionPageModules.has(name));

  assert.deepEqual(
    unplannedModules,
    [],
    "new session page modules should be added to the implementation plan instead of creating ad hoc tiny files",
  );
});

test("planned extracted session modules are substantial and avoid importing the page shell", () => {
  const violations: string[] = [];

  for (const moduleName of plannedExtractedModules) {
    const moduleUrl = new URL(`../../pages/${moduleName}`, import.meta.url);
    if (!existsSync(moduleUrl)) continue;

    const source = readFileSync(moduleUrl, "utf8");
    const minimumLineCount = minimumExtractedModuleLineCounts.get(moduleName) ?? 80;
    if (nonBlankLineCount(source) < minimumLineCount) {
      violations.push(`${moduleName}: fewer than ${minimumLineCount} non-blank lines`);
    }
    if (/from\s+["']\.\/session["']|from\s+["']\.\.\/pages\/session["']/.test(source)) {
      violations.push(`${moduleName}: imports from session.tsx`);
    }
  }

  assert.deepEqual(
    violations,
    [],
    "extracted modules should own durable behavior/view regions and must not depend on the session page shell",
  );
});

test("conversation flow controller owns prompt send orchestration behind grouped dependencies", () => {
  const sessionSource = readFileSync(sessionSourceUrl, "utf8");
  const flowSource = readFileSync(conversationFlowSourceUrl, "utf8");

  assert.match(
    flowSource,
    /export function createSessionConversationFlow\(\s*deps: SessionConversationFlowControllerDeps\s*\)/,
    "session-conversation-flow should expose a controller factory with a typed dependency boundary",
  );
  for (const groupName of [
    "identity",
    "sessionKeys",
    "runtime",
    "pendingHandoff",
    "pendingSubmitted",
    "queue",
    "composer",
    "transcriptEdit",
    "transport",
    "runControl",
    "runState",
    "viewport",
    "feedback",
    "trace",
  ]) {
    assert.match(
      flowSource,
      new RegExp(`${groupName}: \\{`),
      `controller dependencies should include the ${groupName} group instead of passing the full page props object`,
    );
  }
  assert.doesNotMatch(
    flowSource,
    /\bprops\./,
    "conversation flow controller must not depend on the SessionView props object",
  );
  assert.match(
    flowSource,
    /sendPromptImmediate:\s*async\s*\(/,
    "sendPromptImmediate should live inside the controller factory",
  );
  assert.match(
    flowSource,
    /handleSendPrompt:\s*async\s*\(/,
    "handleSendPrompt should live inside the controller factory",
  );
  assert.match(
    flowSource,
    /drainNextQueuedDraft:\s*async\s*\(/,
    "queue draining should live inside the controller factory",
  );
  assert.match(
    sessionSource,
    /const conversationFlow = createSessionConversationFlow\(\{/,
    "SessionView should instantiate the conversation flow controller explicitly",
  );
  assert.match(
    sessionSource,
    /return conversationFlow\.handleSendPrompt\(draft, \{\s*sendNow: options\.sendNow,\s*sendTraceId: options\.sendTraceId,\s*\}\);/s,
    "SessionView should delegate prompt send branching to the controller",
  );
  assert.match(
    sessionSource,
    /const drainNextQueuedDraft = conversationFlow\.drainNextQueuedDraft;/,
    "SessionView should call through the controller instead of owning queue draining inline",
  );
  assert.doesNotMatch(
    sessionSource,
    /const sendPromptImmediate = async\s*\(/,
    "SessionView should no longer own the async prompt send orchestration directly",
  );
  assert.doesNotMatch(
    sessionSource.slice(sessionSource.indexOf("const handleSendPrompt = async"), sessionSource.indexOf("const tempRuntimeUiDiagnosticBadge")),
    /switch \(action\.kind\)/,
    "SessionView handleSendPrompt should not own the conversation-flow action switch",
  );
  assert.doesNotMatch(
    sessionSource,
    /const drainNextQueuedDraft = async\s*\(/,
    "SessionView should no longer own queue drain orchestration directly",
  );
});

test("session view composes planned shell components for left, right, and center regions", () => {
  const sessionSource = readFileSync(sessionSourceUrl, "utf8");

  assert.match(
    sessionSource,
    /import\s+SessionLeftSidebar\s+from\s+["']\.\/session-left-sidebar["'];/,
    "SessionView should import the left sidebar shell component",
  );
  assert.match(
    sessionSource,
    /import\s+SessionRightSidebar\s+from\s+["']\.\/session-right-sidebar["'];/,
    "SessionView should import the right sidebar shell component",
  );
  assert.match(
    sessionSource,
    /import\s+SessionCenter\s+from\s+["']\.\/session-center["'];/,
    "SessionView should import the center shell component",
  );
  assert.match(sessionSource, /<SessionLeftSidebar[\s\S]*workspaceSessionListProps=\{\{/);
  assert.match(sessionSource, /<SessionRightSidebar[\s\S]*artifactsPanelProps=\{\{/);
  assert.match(sessionSource, /<SessionCenter[\s\S]*searchBanner=\{/);
});

test("left sidebar shell keeps workspace and session navigation callback wiring explicit", () => {
  const sessionSource = readFileSync(sessionSourceUrl, "utf8");
  const leftSource = readFileSync(leftSidebarSourceUrl, "utf8");

  assert.match(leftSource, /export default function SessionLeftSidebar\(/);
  assert.match(leftSource, /<WorkspaceSessionList\s+\{\.\.\.props\.workspaceSessionListProps\}/);
  assert.match(leftSource, /<SidebarDashboardNav\s+\{\.\.\.props\.dashboardNavProps\}/);
  assert.match(leftSource, /<SidebarStatusControls\s+\{\.\.\.props\.statusControlsProps\}/);
  assert.match(sessionSource, /onOpenSession:\s*openSessionFromList/);
  assert.match(sessionSource, /onOpenPendingDirectoryDraftInWorkspace:\s*openPendingDirectoryDraftFromList/);
  assert.match(sessionSource, /onOpenSessionSearch:\s*\(\)\s*=>\s*openCommandPalette\("sessions"\)/);
});

test("right sidebar shell owns panel composition without session page business logic", () => {
  const sessionSource = readFileSync(sessionSourceUrl, "utf8");
  const rightSource = readFileSync(rightSidebarSourceUrl, "utf8");

  assert.match(rightSource, /export default function SessionRightSidebar\(/);
  assert.match(rightSource, /<SidebarAdvancedNav\s+\{\.\.\.props\.advancedNavProps\}/);
  assert.match(rightSource, /<ArtifactsPanel\s+\{\.\.\.props\.artifactsPanelProps\}/);
  assert.match(rightSource, /<SessionCapabilitiesPanel\s+\{\.\.\.props\.sessionCapabilitiesPanelProps\}/);
  assert.match(sessionSource, /advancedNavProps=\{\{\s*currentTab:\s*props\.tab,\s*onSelect:\s*openConfig,\s*\}\}/s);
});

test("center shell preserves search, transcript, composer, and disclaimer placement", () => {
  const sessionSource = readFileSync(sessionSourceUrl, "utf8");
  const centerSource = readFileSync(centerSourceUrl, "utf8");

  assert.match(centerSource, /export default function SessionCenter\(/);
  assert.match(centerSource, /props\.searchBanner[\s\S]*props\.reloadBanner[\s\S]*props\.transcript[\s\S]*props\.todoPanel[\s\S]*props\.composerArea/);
  assert.doesNotMatch(centerSource, /conflictModal/);
  assert.match(sessionSource, /transcript=\{\(/);
  assert.match(sessionSource, /composerArea=\{\(/);
  assert.doesNotMatch(sessionSource, /conflictModal=\{\(/);
});
