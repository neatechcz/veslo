import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import cs from "../i18n/locales/cs.js";
import en from "../i18n/locales/en.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("session loading overlay text is localized", () => {
  const appSource = readFileSync(resolve(__dirname, "app.tsx"), "utf8");

  assert.ok("session.opening_conversation" in en);
  assert.ok("session.opening_conversation" in cs);
  assert.equal(appSource.includes("Otevírám konverzaci"), false);
});
