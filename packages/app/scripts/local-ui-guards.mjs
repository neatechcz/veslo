import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const listSource = readFileSync(new URL("../src/app/components/session/workspace-session-list.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../src/app/pages/session.tsx", import.meta.url), "utf8");

assert.equal(
  listSource.includes("showRemoteActions"),
  true,
  "workspace list must gate remote actions behind explicit prop",
);

assert.equal(
  sessionSource.includes("Connect remote worker") && !sessionSource.includes("showRemoteActions"),
  false,
  "session empty state remote CTA must be gated",
);

console.log(JSON.stringify({ ok: true, checks: 2 }));
