import assert from "node:assert/strict";
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

const composerSource = readFileSync(
  new URL("../src/app/components/session/composer.tsx", import.meta.url),
  "utf8",
);

const locales = {
  en: loadTsObject("../src/i18n/locales/en.ts"),
  cs: loadTsObject("../src/i18n/locales/cs.ts"),
  zh: loadTsObject("../src/i18n/locales/zh.ts"),
};

for (const [locale, messages] of Object.entries(locales)) {
  assert.equal(
    typeof messages["session.composer_disclaimer"],
    "string",
    `${locale} locale must define session.composer_disclaimer`,
  );
  assert.notEqual(
    messages["session.composer_disclaimer"].trim(),
    "",
    `${locale} locale must provide non-empty disclaimer copy`,
  );
}

assert.match(
  composerSource,
  /translate\("session\.composer_disclaimer"\)/,
  "composer must render the localized disclaimer",
);

console.log(JSON.stringify({ ok: true, checks: 4 }));
