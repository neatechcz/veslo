import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = new URL("../../../", import.meta.url);
const buttonSource = readFileSync(new URL("../../components/button.tsx", import.meta.url), "utf8");
const globalStyles = readFileSync(new URL("../../index.css", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const dashboardTabRailSource = readFileSync(new URL("../../components/dashboard-tab-rail.tsx", import.meta.url), "utf8");
const skillDrawerSource = readFileSync(new URL("../../components/skill-detail-drawer.tsx", import.meta.url), "utf8");
const confirmModalSource = readFileSync(new URL("../../components/confirm-modal.tsx", import.meta.url), "utf8");
const resetModalSource = readFileSync(new URL("../../components/reset-modal.tsx", import.meta.url), "utf8");
const reloadToastSource = readFileSync(new URL("../../components/reload-workspace-toast.tsx", import.meta.url), "utf8");
const skillReviewSource = readFileSync(new URL("../../components/skill-review-dialog.tsx", import.meta.url), "utf8");
const configSource = readFileSync(new URL("../../pages/config.tsx", import.meta.url), "utf8");
const mcpSource = readFileSync(new URL("../../pages/mcp.tsx", import.meta.url), "utf8");
const scheduledSource = readFileSync(new URL("../../pages/scheduled.tsx", import.meta.url), "utf8");
const skillsSource = readFileSync(new URL("../../pages/skills.tsx", import.meta.url), "utf8");

function tsxSources(directory: string): Array<{ path: string; source: string }> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxSources(path);
    return extname(entry.name) === ".tsx" ? [{ path, source: readFileSync(path, "utf8") }] : [];
  });
}

test("shared Button exposes the three action tiers plus semantic danger", () => {
  assert.match(buttonSource, /variant\?: "primary" \| "outline" \| "ghost" \| "danger";/);
  assert.doesNotMatch(buttonSource, /secondary/);
  assert.match(buttonSource, /primary:[^\n]*bg-dls-accent[^\n]*text-\[#001932\]/);
  assert.match(buttonSource, /outline:[^\n]*border-\[var\(--dls-accent-border\)\][^\n]*text-dls-accent/);
  assert.match(buttonSource, /ghost:[^\n]*border-transparent[^\n]*text-\[var\(--dls-button-ghost\)\][^\n]*hover:bg-\[var\(--dls-accent-tint\)\][^\n]*hover:text-dls-accent/);
  assert.match(buttonSource, /danger:[^\n]*border-transparent[^\n]*bg-red-9[^\n]*text-white[^\n]*hover:bg-red-10/);
});

test("destructive actions retain the semantic danger variant", () => {
  assert.match(confirmModalSource, /variant=\{variant\(\) === "danger" \? "danger" : "primary"\}/);
  assert.match(resetModalSource, /<Button variant="danger"[^>]*onClick=\{props\.onConfirm\}/);
  assert.match(reloadToastSource, /variant=\{props\.hasActiveRuns \? "danger" : "primary"\}/);
  assert.match(skillDrawerSource, /<Show when=\{props\.onDeleteSkill\}>[\s\S]*?<Button[\s\S]*?variant="danger"/);
  assert.match(skillReviewSource, /<Button variant="danger"[^>]*disabled=\{rejectDisabled\(\)\}/);
  assert.match(configSource, /props\.anyActiveRuns \? "danger" : "outline"/);
  assert.equal((mcpSource.match(/variant="danger"/g) ?? []).length, 4);
  assert.equal((scheduledSource.match(/variant="danger"/g) ?? []).length, 1);
  assert.equal((settingsSource.match(/variant="danger"/g) ?? []).length, 3);
  assert.equal((skillsSource.match(/variant="danger"/g) ?? []).length, 3);
});

test("all non-switch buttons inherit the shared 4px geometry and product weight", () => {
  assert.match(
    globalStyles,
    /:where\(button:not\(\[role="switch"\]\)\)[\s\S]*border-radius: var\(--dls-radius\);[\s\S]*font-weight: 500;/,
  );

  const pillButtons = tsxSources(fileURLToPath(appRoot)).flatMap(({ path, source }) => {
    const openings = source.match(/<(?:button|Button)\b[\s\S]*?>/g) ?? [];
    return openings
      .filter((opening) => opening.includes("rounded-full") && !opening.includes('role="switch"'))
      .map((opening) => `${path}: ${opening.replace(/\s+/g, " ").slice(0, 180)}`);
  });

  assert.deepEqual(pillButtons, [], `non-switch pill buttons remain:\n${pillButtons.join("\n")}`);
});

test("settings and detail segmented controls use the cyan selected recipe", () => {
  for (const [name, source] of [
    ["settings", settingsSource],
    ["dashboard tab rail", dashboardTabRailSource],
    ["skill detail tabs", skillDrawerSource],
  ] as const) {
    assert.match(source, /border-\[var\(--dls-accent-border\)\]/, `${name} should use a cyan hairline`);
    assert.match(source, /bg-\[var\(--dls-accent-tint\)\]/, `${name} should use a cyan tint`);
    assert.doesNotMatch(source, /bg-gray-12 text-gray-1/, `${name} should not use a black selected segment`);
  }
});

test("settings toggle switches use the accent token for their on state", () => {
  assert.doesNotMatch(settingsSource, /role="switch"[\s\S]{0,500}bg-green-9/);
  assert.doesNotMatch(settingsSource, /role="switch"[\s\S]{0,500}bg-gray-12/);
  assert.match(settingsSource, /role="switch"[\s\S]{0,500}bg-dls-accent/);
});
