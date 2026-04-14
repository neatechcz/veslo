import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");
const generalSection = source.match(/<Match when=\{activeTab\(\) === "general"\}>[\s\S]*?<\/Match>/)?.[0] ?? "";

test("settings renders a cloud-backed archived sessions section", () => {
  assert.match(source, /<Match when=\{activeTab\(\) === "archived"\}>/);
  assert.match(source, /settings\.archived_sessions_label/);
  assert.match(source, /settings\.archived_sessions_description/);
  assert.match(source, /settings\.archived_sessions_archived_at/);
  assert.match(source, /props\.sessionArchives/);
  assert.match(source, /props\.onUnarchiveSession/);
  assert.match(source, /archivedSessionRows/);
  assert.match(source, /formatRelativeTime/);
  assert.doesNotMatch(generalSection, /settings\.archived_sessions_label/);
});

test("settings exposes unavailable-on-this-device copy for archived sessions", () => {
  assert.match(source, /settings\.archived_sessions_unavailable_on_device/);
  assert.match(source, /settings\.archived_sessions_unarchive/);
});
