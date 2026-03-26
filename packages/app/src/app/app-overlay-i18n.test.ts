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

test("right menu pages avoid hardcoded English copy", () => {
  const skillsSource = readFileSync(resolve(__dirname, "pages/skills.tsx"), "utf8");
  const scheduledSource = readFileSync(resolve(__dirname, "pages/scheduled.tsx"), "utf8");

  assert.equal(skillsSource.includes("Paste a link to preview"), false);
  assert.equal(skillsSource.includes("Failed to load skill."), false);
  assert.equal(skillsSource.includes("Failed to save skill."), false);
  assert.equal(scheduledSource.includes("Daily planning brief"), false);
  assert.equal(scheduledSource.includes("Schedule a job"), false);
  assert.equal(scheduledSource.includes("Run this automation now"), false);
});
