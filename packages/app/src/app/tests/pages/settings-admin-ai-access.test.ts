import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../pages/settings.tsx", import.meta.url), "utf8");
const generalSection = source.match(/<Match when=\{activeTab\(\) === "general"\}>[\s\S]*?<\/Match>/)?.[0] ?? "";

test("settings shows admin-managed ai access only in developer mode", () => {
  assert.match(
    generalSection,
    /<Show when=\{props\.developerMode\}>[\s\S]*ui\.literal\.ai_access_1fcmzn[\s\S]*ui\.literal\.provider_and_model_assignment_is_managed_by__ekvlg6/,
  );
  assert.doesNotMatch(source, /Connect provider/);
  assert.doesNotMatch(source, /activeTab\(\)\s*===\s*"model"/);
  assert.doesNotMatch(source, /openDefaultModelPicker/);
  assert.doesNotMatch(source, /aiAccessAllowedModels|allowed_models_tnz56v|default_model_463spj/);
  assert.match(source, /translate\("settings\.effective_model"\)/);
});
