import assert from "node:assert/strict";
import test from "node:test";

import StagingRendererCanary, {
  STAGING_RENDERER_CANARY_MARKER,
} from "./staging-renderer-canary.js";

test("staging renderer canary throws its deterministic render marker", () => {
  assert.throws(
    () => StagingRendererCanary(),
    new RegExp(STAGING_RENDERER_CANARY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});
