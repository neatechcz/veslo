import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import vm from "node:vm";

const loadTsObject = (relativePath) => {
  if (!existsSync(new URL(relativePath, import.meta.url))) {
    throw new Error(`Missing file: ${relativePath}`);
  }

  let source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
  source = source.replace(/export default/, "module.exports =");
  source = source.replace(/\}\s+as const;\s*$/, "}");

  const context = { module: { exports: {} }, exports: {} };
  vm.runInNewContext(source, context, { filename: relativePath });
  return context.module.exports;
};

const readSource = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8");

const en = loadTsObject("../src/i18n/locales/en.ts");
const cs = loadTsObject("../src/i18n/locales/cs.ts");
const enKeys = Object.keys(en).sort();
const csKeys = Object.keys(cs).sort();

const missingInCs = enKeys.filter((key) => !csKeys.includes(key));
const extraInCs = csKeys.filter((key) => !enKeys.includes(key));

assert.deepEqual(
  { missingInCs, extraInCs },
  { missingInCs: [], extraInCs: [] },
  `Czech locale key mismatch:\nmissing=${missingInCs.join(", ")}\nextra=${extraInCs.join(", ")}`
);

const indexSource = readSource("../src/i18n/index.ts");

assert.match(indexSource, /export type Language = "en" \| "zh" \| "cs";/);
assert.match(indexSource, /export const LANGUAGES: Language\[] = \["en", "zh", "cs"\];/);

const optionMatches = [...indexSource.matchAll(/value:\s*"([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(optionMatches, ["en", "cs"], `Expected visible language options [en, cs], got [${optionMatches.join(", ")}]`);

const appRoot = new URL("..", import.meta.url);
const focusedI18nTests = [
  "src/app/tests/reload-banner-i18n.test.ts",
  "src/app/tests/plugins-policy-i18n.test.ts",
].filter((path) => existsSync(new URL(path, appRoot)));

if (focusedI18nTests.length > 0) {
  const result = spawnSync(
    process.execPath,
    ["--test", "--import=tsx/esm", ...focusedI18nTests],
    {
      cwd: appRoot,
      stdio: "inherit",
    },
  );
  assert.equal(result.status, 0, `Focused i18n tests failed with exit code ${result.status ?? "unknown"}`);
}

console.log(
  JSON.stringify({
    ok: true,
    englishKeys: enKeys.length,
    czechKeys: csKeys.length,
    visibleOptions: optionMatches,
  })
);
