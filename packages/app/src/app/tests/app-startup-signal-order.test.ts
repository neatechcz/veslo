import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

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
