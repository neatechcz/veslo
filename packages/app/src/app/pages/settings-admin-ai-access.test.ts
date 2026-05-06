import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");
const generalSection = source.match(/<Match when=\{activeTab\(\) === "general"\}>[\s\S]*?<\/Match>/)?.[0] ?? "";

test("settings shows admin-managed ai access only in developer mode", () => {
  assert.match(
    generalSection,
    /<Show when=\{props\.developerMode\}>[\s\S]*>AI access<[\s\S]*managed by the platform admin/i,
  );
  assert.doesNotMatch(source, /Connect provider/);
  assert.doesNotMatch(source, /activeTab\(\)\s*===\s*"model"/);
  assert.doesNotMatch(source, /openDefaultModelPicker/);
});
