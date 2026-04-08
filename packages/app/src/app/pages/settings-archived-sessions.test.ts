import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");

test("settings renders a cloud-backed archived sessions section", () => {
  assert.match(source, /settings\.archived_sessions_label/);
  assert.match(source, /settings\.archived_sessions_description/);
  assert.match(source, /settings\.archived_sessions_archived_at/);
  assert.match(source, /props\.sessionArchives/);
  assert.match(source, /props\.onUnarchiveSession/);
  assert.match(source, /archivedSessionRows/);
  assert.match(source, /formatRelativeTime/);
});

test("settings exposes unavailable-on-this-device copy for archived sessions", () => {
  assert.match(source, /settings\.archived_sessions_unavailable_on_device/);
  assert.match(source, /settings\.archived_sessions_unarchive/);
});
