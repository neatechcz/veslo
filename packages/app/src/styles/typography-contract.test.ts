import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const typographyPath = new URL("./typography.css", import.meta.url);
const indexCssPath = new URL("../app/index.css", import.meta.url);
const tailwindPath = new URL("../../tailwind.config.ts", import.meta.url);
const packageJsonPath = new URL("../../package.json", import.meta.url);

const readIfExists = (path: URL) => (existsSync(path) ? readFileSync(path, "utf8") : "");

const typography = readIfExists(typographyPath);
const indexCss = readIfExists(indexCssPath);
const tailwind = readIfExists(tailwindPath);
const packageJson = readIfExists(packageJsonPath);

test("index.css imports the centralized typography contract", () => {
  assert.match(indexCss, /@import "\.\.\/styles\/typography\.css";/);
});

test("package.json includes the self-hosted font packages used by the app", () => {
  assert.match(packageJson, /"@fontsource-variable\/source-sans-3"/);
  assert.match(packageJson, /"@fontsource-variable\/ibm-plex-sans"/);
  assert.match(packageJson, /"@fontsource\/ibm-plex-mono"/);
});

test("typography contract imports the chosen font packages", () => {
  assert.match(typography, /@import "@fontsource-variable\/source-sans-3";/);
  assert.match(typography, /@import "@fontsource-variable\/ibm-plex-sans";/);
  assert.match(typography, /@import "@fontsource\/ibm-plex-mono\/400\.css";/);
  assert.match(typography, /@import "@fontsource\/ibm-plex-mono\/500\.css";/);
});

test("typography contract defines reading, product, and mono font variables", () => {
  assert.match(typography, /--veslo-font-reading:[^;]*Source Sans 3/);
  assert.match(typography, /--veslo-font-product:[^;]*IBM Plex Sans/);
  assert.match(typography, /--veslo-font-mono:[^;]*IBM Plex Mono/);
});

test("typography contract defines semantic font and type utilities", () => {
  assert.match(typography, /@utility font-reading/);
  assert.match(typography, /@utility font-product/);
  assert.match(typography, /@utility type-ui-md/);
  assert.match(typography, /@utility type-reading-md/);
  assert.match(typography, /@utility type-title-md/);
  assert.match(typography, /--veslo-type-ui-sm:/);
  assert.match(typography, /--veslo-type-reading-md:/);
});

test("tailwind maps sans and mono to the Veslo typography variables", () => {
  assert.match(tailwind, /fontFamily:/);
  assert.match(tailwind, /sans:\s*\["var\(--veslo-font-product\)"/);
  assert.match(tailwind, /mono:\s*\["var\(--veslo-font-mono\)"/);
});
