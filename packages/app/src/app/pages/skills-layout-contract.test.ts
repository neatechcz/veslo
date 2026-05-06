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

test("skills page removes legacy new skill toolbar action", () => {
  assert.equal(source.includes('translate("skills.new_skill")'), false);
});

test("skills page install section uses org catalog placeholder text", () => {
  assert.match(source, /translate\("skills\.org_catalog_placeholder"\)/);
});

test("skills page does not duplicate org catalog placeholder when hub status is shown", () => {
  assert.match(
    source,
    /fallback=\{\s*<Show when=\{!props\.hubSkillsStatus\}>[\s\S]*translate\("skills\.org_catalog_placeholder"\)/,
  );
});

test("skills toast messages stay visible for at least four seconds", () => {
  assert.match(
    source,
    /const SKILLS_TOAST_DISMISS_DELAY_MS = 4_000;/,
    "skills toast dismiss delay should be defined as at least four seconds",
  );
  assert.match(
    source,
    /window\.setTimeout\(\(\) => setToast\(null\), SKILLS_TOAST_DISMISS_DELAY_MS\)/,
    "skills toasts should use the four-second dismiss delay",
  );
  assert.equal(source.includes("setToast(null), 2400"), false);
});
