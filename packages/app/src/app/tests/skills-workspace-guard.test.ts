import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import cs from "../../i18n/locales/cs.js";
import en from "../../i18n/locales/en.js";
import zh from "../../i18n/locales/zh.js";

const extensionsSource = readFileSync(new URL("../context/extensions.ts", import.meta.url), "utf8");
const skillsPageSource = readFileSync(new URL("../pages/skills.tsx", import.meta.url), "utf8");

test("skills surface keeps workspace-required messaging scoped to target actions", () => {
  assert.match(extensionsSource, /translate\("skills\.pick_workspace_first"\)/);
  assert.doesNotMatch(skillsPageSource, /skills\.pick_workspace_first/);
  assert.equal(Object.hasOwn(en, "skills.pick_workspace_first"), true);
  assert.equal(Object.hasOwn(cs, "skills.pick_workspace_first"), true);
  assert.equal(Object.hasOwn(zh, "skills.pick_workspace_first"), true);
});
