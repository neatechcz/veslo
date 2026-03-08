import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workspaceSource = readFileSync(new URL("../src/app/context/workspace.ts", import.meta.url), "utf8");
const utilsSource = readFileSync(new URL("../src/app/utils/index.ts", import.meta.url), "utf8");

assert.equal(
  workspaceSource.includes("CLOUD_ONLY_MODE ? filterRemoteWorkspaces(ws.workspaces) : ws.workspaces"),
  false,
  "bootstrap must not filter out local workspaces in local-sync mode",
);

assert.equal(
  utilsSource.includes('if (pref === "local" || pref === "server") return "server";'),
  false,
  "startup preference reader must no longer coerce local->server",
);

console.log(JSON.stringify({ ok: true, checks: 2 }));
