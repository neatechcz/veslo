import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const dashboardTabRailSource = readFileSync(new URL("../../components/dashboard-tab-rail.tsx", import.meta.url), "utf8");
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

test("settings tab list exposes general, archived, and developer-only debug", () => {
  assert.match(dashboardTabRailSource, /baseItems[\s\S]*\{\s*kind:\s*"settings",\s*tab:\s*"general"\s*\}/);
  assert.match(dashboardTabRailSource, /baseItems[\s\S]*\{\s*kind:\s*"settings",\s*tab:\s*"archived"\s*\}/);
  assert.doesNotMatch(dashboardTabRailSource, /\{\s*kind:\s*"settings",\s*tab:\s*"extensions"\s*\}/);
  assert.doesNotMatch(dashboardTabRailSource, /\{\s*kind:\s*"settings",\s*tab:\s*"advanced"\s*\}/);
  assert.match(dashboardTabRailSource, /developerItems[\s\S]*\{\s*kind:\s*"settings",\s*tab:\s*"debug"\s*\}/);
  assert.doesNotMatch(source, /<Match when=\{activeTab\(\) === "extensions"\}>/);
  assert.match(source, /if \(props\.developerMode\) tabs\.push\("debug"\);/);
});

test("settings keeps appearance in general and developer-gates admin-managed ai access", () => {
  assert.match(generalSection, /translate\("settings\.appearance_title"\)/);
  assert.doesNotMatch(generalSection, /System mode follows your OS preference automatically\./);
  assert.match(
    generalSection,
    /<Show when=\{props\.developerMode\}>[\s\S]*ui\.literal\.ai_access_1fcmzn[\s\S]*ui\.literal\.provider_and_model_assignment_is_managed_by__ekvlg6/,
  );
  assert.doesNotMatch(source, /<Match when=\{activeTab\(\) === "model"\}>/);
  assert.doesNotMatch(archivedSection, /ui\.literal\.ai_access_1fcmzn/);
});

test("settings exposes unavailable-on-this-device copy for archived sessions", () => {
  assert.match(source, /settings\.archived_sessions_unavailable_on_device/);
  assert.match(source, /settings\.archived_sessions_unarchive/);
});

test("settings archived sessions expose stable row and unarchive selectors", () => {
  assert.match(archivedSection, /data-testid=["']settings-archived-session-row["']/);
  assert.match(archivedSection, /data-testid=["']settings-archived-session-unarchive-button["']/);
  assert.match(archivedSection, /data-session-id=\{item\.sessionId\}/);
  assert.match(archivedSection, /data-workspace-id=\{item\.workspaceId\}/);
});

test("settings unarchive preserves archived session directory scope", () => {
  assert.match(
    source,
    /props\.onUnarchiveSession\?\.\(item\.workspaceId, item\.sessionId, item\.workspaceIdentity, item\.resolvedDirectory\)/,
    "settings archived-session unarchive should pass directory scope so duplicate raw session ids are not removed together",
  );
});
