import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebar = readFileSync(new URL("../components/session/sidebar.tsx", import.meta.url), "utf8");
const dashboard = readFileSync(new URL("./dashboard.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("./settings.tsx", import.meta.url), "utf8");
const skills = readFileSync(new URL("./skills.tsx", import.meta.url), "utf8");
const mcp = readFileSync(new URL("./mcp.tsx", import.meta.url), "utf8");
const onboarding = readFileSync(new URL("./onboarding.tsx", import.meta.url), "utf8");

test("shell titles and navigation chrome use product typography roles", () => {
  assert.match(sidebar, /font-product/);
  assert.match(dashboard, /font-product/);
  assert.match(skills, /type-title-md/);
  assert.match(mcp, /type-title-md/);
  assert.match(onboarding, /type-title-md|type-title-lg/);
});

test("dense metadata uses semantic small typography utilities", () => {
  assert.match(sidebar, /type-ui-xs/);
  assert.match(settings, /type-ui-xs/);
  assert.match(skills, /type-ui-xs/);
  assert.match(mcp, /type-ui-xs/);
});

test("technical diagnostics stay mono while surrounding labels use product chrome", () => {
  assert.match(settings, /font-mono/);
  assert.match(settings, /font-product/);
});
