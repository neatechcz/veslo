import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./skills.tsx", import.meta.url), "utf8");

test("skills page removes worker profile and mode stat cards", () => {
  assert.equal(source.includes('translate("skills.worker_profile")'), false);
  assert.equal(source.includes('translate("skills.stat_skill_creator")'), false);
  assert.equal(source.includes('translate("skills.stat_mode")'), false);
});

test("skills page keeps create skill in chat CTA", () => {
  assert.match(source, /translate\("skills\.create_in_chat"\)/);
});

test("skills page install section uses org catalog placeholder text", () => {
  assert.match(source, /translate\("skills\.org_catalog_placeholder"\)/);
});
