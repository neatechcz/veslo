import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import cs from "../i18n/locales/cs.js";
import en from "../i18n/locales/en.js";
import zh from "../i18n/locales/zh.js";

const extensionsSource = readFileSync(new URL("./context/extensions.ts", import.meta.url), "utf8");

test("skills surface no longer blocks on choosing a workspace folder first", () => {
  assert.doesNotMatch(extensionsSource, /skills\.pick_workspace_first/);
  assert.equal(Object.hasOwn(en, "skills.pick_workspace_first"), false);
  assert.equal(Object.hasOwn(cs, "skills.pick_workspace_first"), false);
  assert.equal(Object.hasOwn(zh, "skills.pick_workspace_first"), false);
});
