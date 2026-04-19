import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");

test("sendPrompt waits for managed bootstrap readiness before reading client", () => {
  assert.match(
    source,
    /async function sendPrompt\(draft\?: ComposerDraft\)[\s\S]*?await ensureManagedAiBootstrapReady\(\);\s*const c = client\(\);/s,
    "sendPrompt should wait for managed bootstrap readiness before grabbing the local client",
  );
});

test("createSessionAndOpen waits for managed bootstrap readiness before reading client", () => {
  assert.match(
    source,
    /async function createSessionAndOpen\(\)[\s\S]*?await ensureManagedAiBootstrapReady\(\);\s*const c = client\(\);/s,
    "createSessionAndOpen should wait for managed bootstrap readiness before grabbing the local client",
  );
});
