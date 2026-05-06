import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MODEL_VARIANT,
  MODEL_VARIANT_DEFAULT_MIGRATION_VERSION,
  resolveStartupModelVariant,
} from "./model-variant.js";

test("startup model variant migration overwrites existing stored thinking with max", () => {
  const resolved = resolveStartupModelVariant({
    storedVariant: "low",
    storedMigrationVersion: null,
  });

  assert.equal(resolved.variant, DEFAULT_MODEL_VARIANT);
  assert.equal(resolved.variant, "xhigh");
  assert.equal(resolved.persistVariant, true);
  assert.equal(resolved.persistMigrationVersion, MODEL_VARIANT_DEFAULT_MIGRATION_VERSION);
});
