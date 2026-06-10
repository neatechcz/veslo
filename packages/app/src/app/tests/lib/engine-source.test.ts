import assert from "node:assert/strict";
import test from "node:test";

import {
  parseStoredEngineSourceExplicitPreference,
  resolveStoredEngineSourcePreference,
} from "../../lib/engine-source.js";

test("desktop runtime migrates a stale path preference back to the bundled sidecar", () => {
  assert.deepEqual(
    resolveStoredEngineSourcePreference({
      isTauriRuntime: true,
      storedSource: "path",
      storedCustomBinPath: "",
      storedSourceExplicit: false,
    }),
    {
      source: "sidecar",
      explicit: false,
    },
  );
});

test("desktop runtime migrates even an explicitly chosen PATH engine to the bundled sidecar", () => {
  assert.deepEqual(
    resolveStoredEngineSourcePreference({
      isTauriRuntime: true,
      storedSource: "path",
      storedCustomBinPath: "",
      storedSourceExplicit: true,
    }),
    {
      source: "sidecar",
      explicit: false,
    },
  );
});

test("custom engine source requires a stored binary path", () => {
  assert.deepEqual(
    resolveStoredEngineSourcePreference({
      isTauriRuntime: true,
      storedSource: "custom",
      storedCustomBinPath: "",
      storedSourceExplicit: true,
    }),
    {
      source: "sidecar",
      explicit: false,
    },
  );
});

test("web runtime keeps the stored PATH engine preference", () => {
  assert.deepEqual(
    resolveStoredEngineSourcePreference({
      isTauriRuntime: false,
      storedSource: "path",
      storedCustomBinPath: "",
      storedSourceExplicit: false,
    }),
    {
      source: "path",
      explicit: false,
    },
  );
});

test("explicit preference parser accepts truthy storage values", () => {
  assert.equal(parseStoredEngineSourceExplicitPreference("1"), true);
  assert.equal(parseStoredEngineSourceExplicitPreference("true"), true);
  assert.equal(parseStoredEngineSourceExplicitPreference("false"), false);
  assert.equal(parseStoredEngineSourceExplicitPreference(null), false);
});
