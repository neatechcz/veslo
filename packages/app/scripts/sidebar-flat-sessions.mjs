import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const listSource = readFileSync(
  new URL("../src/app/components/session/workspace-session-list.tsx", import.meta.url),
  "utf8",
);

assert.equal(
  listSource.includes('type SidebarViewMode = "by-project" | "recent"'),
  true,
  "workspace session list should define by-project and recent sidebar modes",
);

assert.equal(
  listSource.includes("const projectGroups = createMemo"),
  true,
  "workspace session list should derive grouped project sections",
);

assert.equal(
  listSource.includes("props.workspaceSessionGroups.flatMap"),
  true,
  "workspace session list should still derive a recent flat feed",
);

assert.equal(
  listSource.includes('aria-label="By project"'),
  true,
  "workspace session list should render a By project toggle control",
);

assert.equal(
  listSource.includes('aria-label="Recent"'),
  true,
  "workspace session list should render a Recent toggle control",
);

assert.equal(
  listSource.includes('aria-label="Create session in this project"'),
  true,
  "workspace session list should expose project-scoped session creation",
);

assert.equal(
  listSource.includes('aria-label="New task"'),
  false,
  "workspace session list should not render per-session create buttons",
);

console.log(JSON.stringify({ ok: true, checks: 7 }));
