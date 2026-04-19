import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");
const generalSection = source.match(/<Match when=\{activeTab\(\) === "general"\}>[\s\S]*?<\/Match>/)?.[0] ?? "";
const archivedSection = source.match(/<Match when=\{activeTab\(\) === "archived"\}>[\s\S]*?<\/Match>/)?.[0] ?? "";

test("settings renders archived sessions inside the archived tab only", () => {
  const archivedMatch = source.match(/<Match when=\{activeTab\(\) === "archived"\}>[\s\S]*?<\/Match>/);
  const generalMatch = source.match(/<Match when=\{activeTab\(\) === "general"\}>[\s\S]*?<\/Match>/);

  assert.ok(archivedMatch, "archived tab branch should exist");
  assert.ok(generalMatch, "general tab branch should exist");
  assert.match(archivedMatch[0], /settings\.archived_sessions_label/);
  assert.match(archivedMatch[0], /settings\.archived_sessions_description/);
  assert.match(archivedMatch[0], /settings\.archived_sessions_archived_at/);
  assert.match(archivedMatch[0], /props\.sessionArchives/);
  assert.match(archivedMatch[0], /props\.onUnarchiveSession/);
  assert.match(archivedMatch[0], /archivedSessionRows/);
  assert.match(archivedMatch[0], /formatRelativeTime/);
  assert.doesNotMatch(generalMatch[0], /settings\.archived_sessions_label/);
});

test("settings tab list starts with general and archived before developer-only tabs", () => {
  assert.match(source, /const tabs: SettingsTab\[] = \["general", "archived"\]/);
  assert.match(source, /if \(props\.developerMode\) tabs\.push\("model", "advanced", "debug"\);/);
});

test("settings keeps appearance controls in general and provider wiring in model", () => {
  const modelSection = source.match(/<Match when=\{activeTab\(\) === "model"\}>[\s\S]*?<\/Match>/)?.[0] ?? "";

  assert.match(generalSection, /translate\("settings\.appearance_title"\)/);
  assert.doesNotMatch(generalSection, /System mode follows your OS preference automatically\./);
  assert.doesNotMatch(generalSection, /Providers/);
  assert.match(modelSection, /Providers/);
  assert.doesNotMatch(archivedSection, /Providers/);
});

test("settings exposes unavailable-on-this-device copy for archived sessions", () => {
  assert.match(source, /settings\.archived_sessions_unavailable_on_device/);
  assert.match(source, /settings\.archived_sessions_unarchive/);
});
