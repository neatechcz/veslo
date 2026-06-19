import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import cs from "../../i18n/locales/cs.js";
import en from "../../i18n/locales/en.js";
import zh from "../../i18n/locales/zh.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("session loading overlay text is localized", () => {
  const appSource = readFileSync(resolve(__dirname, "../app.tsx"), "utf8");

  assert.ok("session.opening_conversation" in en);
  assert.ok("session.opening_conversation" in cs);
  assert.equal(appSource.includes("Otevírám konverzaci"), false);
});

test("managed AI access state text is localized", () => {
  const appSource = readFileSync(resolve(__dirname, "../app.tsx"), "utf8");
  const requiredKeys = [
    "ai_access.admin_managed",
    "ai_access.loading",
    "ai_access.not_configured",
    "ai_access.invalid",
    "ai_access.load_failed",
  ] as const;

  for (const key of requiredKeys) {
    assert.ok(key in en, `${key} should have an English fallback`);
    assert.ok(key in cs, `${key} should have a Czech translation`);
    assert.ok(key in zh, `${key} should have a Chinese translation`);
  }

  assert.equal(cs["ai_access.loading"], "Načítám konfiguraci přístupu k AI.");
  assert.equal(/AI_ACCESS_LOADING_MESSAGE(?!_KEY)/.test(appSource), false);
  assert.equal(appSource.includes('"Failed to load AI access"'), false);
});

test("right menu pages avoid hardcoded English copy", () => {
  const skillsSource = readFileSync(resolve(__dirname, "../pages/skills.tsx"), "utf8");
  const scheduledSource = readFileSync(resolve(__dirname, "../pages/scheduled.tsx"), "utf8");

  assert.equal(skillsSource.includes("Paste a link to preview"), false);
  assert.equal(skillsSource.includes("Failed to load skill."), false);
  assert.equal(skillsSource.includes("Failed to save skill."), false);
  assert.equal(scheduledSource.includes("Daily planning brief"), false);
  assert.equal(scheduledSource.includes("Schedule a job"), false);
  assert.equal(scheduledSource.includes("Run this automation now"), false);
});
