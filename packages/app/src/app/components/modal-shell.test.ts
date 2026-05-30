import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./modal-shell.tsx", import.meta.url), "utf8");

test("modal shell supports an unconstrained size for near full-page modals", () => {
  assert.match(source, /export type ModalSize = "sm" \| "md" \| "lg" \| "none"/);
  assert.match(source, /none: ""/);
  assert.match(source, /\$\{SIZE_CLASS\[size\(\)\]\}/);
});

test("modal shell captures Escape globally so the top modal closes before underlying drawers", () => {
  assert.match(source, /createEffect/);
  assert.match(source, /onCleanup/);
  assert.match(source, /if \(!props\.open\) return/);
  assert.match(source, /const closeFromEscape = \(event: KeyboardEvent\) =>/);
  assert.match(source, /if \(event\.defaultPrevented\) return/);
  assert.match(source, /if \(event\.key !== "Escape"\) return/);
  assert.match(source, /document\.querySelectorAll\("\[data-modal-shell-root\]"\)/);
  assert.match(source, /event\.preventDefault\(\)/);
  assert.match(source, /props\.onClose\?\.\(\)/);
  assert.match(source, /window\.addEventListener\("keydown", closeFromEscape, true\)/);
  assert.match(source, /window\.removeEventListener\("keydown", closeFromEscape, true\)/);
  assert.match(source, /data-modal-shell-root/);
});
