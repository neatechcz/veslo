import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertInjectedDebugIds,
  assertNoSourceMapsRemain,
  assertStagingRendererCanaryBuildPolicy,
  assertStagingRendererCanaryOutput,
  missingSourceMapUploadEnvironment,
  removeSourceMapReferences,
  removeSourceMaps,
  sourceMapPairs,
  STAGING_RENDERER_CANARY_MARKER,
} from "./build-desktop-ui.mjs";

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "veslo-source-map-"));
  const assets = join(directory, "assets");
  mkdirSync(assets);
  const sourcePath = join(assets, "app.js");
  const mapPath = `${sourcePath}.map`;
  writeFileSync(sourcePath, "console.log('ready');\n");
  writeFileSync(mapPath, JSON.stringify({ version: 3, sources: ["app.tsx"] }));
  return { directory, sourcePath, mapPath };
}

test("source-map helper accepts hidden JavaScript maps and leaves no public map artifact", () => {
  const fixture = createFixture();
  try {
    const pairs = sourceMapPairs(fixture.directory);
    assert.equal(pairs.length, 1);

    removeSourceMapReferences(fixture.directory);
    removeSourceMaps(fixture.directory);
    assertNoSourceMapsRemain(fixture.directory);
    assert.doesNotMatch(readFileSync(fixture.sourcePath, "utf8"), /sourceMappingURL=/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("source-map helper requires matching debug IDs before upload", () => {
  const fixture = createFixture();
  try {
    writeFileSync(fixture.sourcePath, "//# debugId=event-id\nconsole.log('ready');\n");
    writeFileSync(
      fixture.mapPath,
      JSON.stringify({ version: 3, sources: ["app.tsx"], debug_id: "event-id" }),
    );
    const [artifact] = assertInjectedDebugIds(sourceMapPairs(fixture.directory));
    assert.deepEqual(artifact, {
      source: artifact.source,
      sourceMap: artifact.sourceMap,
      debugId: "event-id",
    });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("source-map helper reports every upload credential that is absent", () => {
  assert.deepEqual(missingSourceMapUploadEnvironment({ SENTRY_URL: "https://glitchtip.example" }), [
    "SENTRY_AUTH_TOKEN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
  ]);
});

test("staging renderer canary output is present only for its compile-time build", () => {
  const fixture = createFixture();
  try {
    assertStagingRendererCanaryOutput(fixture.directory, false);
    assert.throws(
      () => assertStagingRendererCanaryOutput(fixture.directory, true),
      /canary was requested but is absent/,
    );

    writeFileSync(fixture.sourcePath, `throw new Error(${JSON.stringify(STAGING_RENDERER_CANARY_MARKER)});\n`);
    assertStagingRendererCanaryOutput(fixture.directory, true);
    assert.throws(
      () => assertStagingRendererCanaryOutput(fixture.directory, false),
      /canary leaked into a regular frontend build/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("staging renderer canary rejects non-staging build environments", () => {
  assertStagingRendererCanaryBuildPolicy({
    VESLO_STAGING_RENDERER_CANARY: "1",
    VITE_VESLO_GLITCHTIP_ENVIRONMENT: "staging",
  });
  assert.throws(
    () => assertStagingRendererCanaryBuildPolicy({ VESLO_STAGING_RENDERER_CANARY: "1" }),
    /requires the GlitchTip environment to be staging/,
  );
});
