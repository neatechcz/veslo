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

  for (const literal of ["Select Folder", "Choose Preset", "<span>Choose</span>", "Opening..."]) {
    assert.equal(source.includes(literal), false, `Unexpected hardcoded label: ${literal}`);
  }
});
