import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");
const typesSource = readFileSync(new URL("../types.ts", import.meta.url), "utf8");

test("session view receives composer target picker state from app", () => {
  assert.match(typesSource, /export type ComposerTargetOption = \{/);
  assert.match(typesSource, /export type ComposerTargetSwitchResult =/);
  assert.match(appSource, /composerTargetOptions: composerTargetOptions\(\)/);
  assert.match(appSource, /activeComposerTargetId: activeComposerTargetId\(\)/);
  assert.match(appSource, /switchComposerTarget/);
  assert.match(sessionSource, /composerTargetOptions: ComposerTargetOption\[\];/);
});

test("app builds target options from workspaces and pending drafts", () => {
  assert.match(appSource, /const \[pendingDraftSummaries, setPendingDraftSummaries\]/);
  assert.match(appSource, /pendingSessionDraftsList\(\)/);
  assert.match(appSource, /draftStatus: .*\? "draft" : null/s);
  assert.match(appSource, /kind: "chat"/);
  assert.match(appSource, /kind: "workspace"/);
});
