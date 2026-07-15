import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const developerModeSource = readFileSync(
  new URL("../lib/developer-mode.ts", import.meta.url),
  "utf8",
);

test("startup effects only read visibility/debug signals after they are declared", () => {
  for (const signalName of ["developerMode", "documentVisible"] as const) {
    const declaration = Math.max(
      source.indexOf(`const ${signalName}`),
      source.indexOf(`const [${signalName}`),
    );
    const firstRead = source.indexOf(`${signalName}()`);

    assert.ok(declaration >= 0, `${signalName} declaration should be present`);
    assert.ok(firstRead >= 0, `${signalName} should be read by startup code`);
    assert.ok(
      declaration < firstRead,
      `${signalName} must be declared before any startup effect reads it`,
    );
  }
});

test("developer mode is gated by the debug URL parameter", () => {
  assert.doesNotMatch(source, /const developerMode = \(\) => true;/);
  assert.match(
    source,
    /const developerMode = \(\) => resolveDeveloperModeFromSearch\(location\.search\);/,
    "developer mode should be derived from the current route search string",
  );
  assert.match(
    developerModeSource,
    /function resolveDeveloperModeFromSearch\(search: string\)[\s\S]*new URLSearchParams\(search\.startsWith\("\?"\) \? search\.slice\(1\) : search\)[\s\S]*params\.has\("debug"\)/,
    "the debug URL parameter should be the explicit developer-mode entry point",
  );
});
