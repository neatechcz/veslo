import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const listSource = readFileSync(
  new URL("../src/app/components/session/workspace-session-list.tsx", import.meta.url),
  "utf8",
);

assert.equal(
  listSource.includes("workspaceSessionGroups.flatMap"),
  true,
  "workspace session list should flatten sessions across workers",
);

assert.equal(
  listSource.includes("MAX_SESSIONS_PREVIEW"),
  false,
  "workspace session list should not use grouped preview pagination",
);

assert.equal(
  listSource.includes("COLLAPSED_SESSIONS_PREVIEW"),
  false,
  "workspace session list should not use collapsed grouped previews",
);

assert.equal(
  listSource.includes("toggleWorkspaceExpanded"),
  false,
  "workspace session list should not render worker expand/collapse controls",
);

assert.equal(
  listSource.includes("showMoreSessions"),
  false,
  "workspace session list should not expose grouped show-more actions",
);

console.log(JSON.stringify({ ok: true, checks: 5 }));
