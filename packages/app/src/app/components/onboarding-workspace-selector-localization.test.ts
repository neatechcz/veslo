import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./onboarding-workspace-selector.tsx", import.meta.url), "utf8");

test("onboarding workspace selector localizes folder input labels", () => {
  assert.match(source, /useTranslate/);
  assert.match(source, /translate\("dashboard\.select_folder"\)/);
  assert.match(source, /translate\("common\.choose"\)/);
  assert.match(source, /translate\("dashboard\.opening"\)/);
  assert.match(source, /translate\("dashboard\.choose_preset"\)/);
  assert.match(source, /translate\("dashboard\.create_workspace_confirm"\)/);
  assert.match(source, /translate\("dashboard\.choose_folder_continue"\)/);

  for (const literal of ["Select Folder", "Choose Preset", "<span>Choose</span>", "Opening...", "Create Worker"]) {
    assert.equal(source.includes(literal), false, `Unexpected hardcoded label: ${literal}`);
  }
});

test("onboarding workspace selector wires the create action", () => {
  assert.match(source, /const handleConfirm = async \(\) => \{/);
  assert.match(source, /await props\.onConfirm\(preset\(\), folder\);/);
  assert.match(source, /onClick=\{handleConfirm\}/);
});
