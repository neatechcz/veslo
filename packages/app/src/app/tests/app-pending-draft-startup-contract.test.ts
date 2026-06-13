import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");

test("app delegates pending draft startup matching and hydration decisions to the controller", () => {
  assert.match(
    source,
    /import \{\s*findStoredPendingDraftSummary,\s*resolvePendingDraftStartupHydration,\s*\} from "\.\/controllers\/pending-draft-startup-controller";/,
    "app.tsx should import pending draft startup helpers",
  );
});

test("startup pending draft hydration validates before mutating active pending draft state", () => {
  const start = source.indexOf("const storedPendingDraftKey = readActivePendingDraftKey();");
  const end = source.indexOf("setActivePendingDraftStorageReady(true);", start);
  assert.ok(start >= 0 && end > start, "startup pending draft hydration block should be present");
  const hydrationSource = source.slice(start, end);

  assert.doesNotMatch(
    hydrationSource,
    /setActivePendingDraftKey\(storedPendingDraftKey\);[\s\S]*pendingSessionDraftsList\(/,
    "startup should not mark a pending draft active before durable validation",
  );
  assert.match(
    hydrationSource,
    /const matchingPendingDraft = findStoredPendingDraftSummary\(\{[\s\S]*storedPendingDraftKey,[\s\S]*pendingDrafts,[\s\S]*\}\);/,
    "matching the stored draft key should be delegated to the startup controller",
  );
  assert.match(
    hydrationSource,
    /const hydrationDecision = resolvePendingDraftStartupHydration\(\{[\s\S]*storedPendingDraftKey,[\s\S]*matchingPendingDraft,[\s\S]*loadedPendingDraft,[\s\S]*restoreError,[\s\S]*\}\);/,
    "hydration decision should be delegated after the draft payload is loaded",
  );
  assert.match(
    hydrationSource,
    /case "hydrate":[\s\S]*setActivePendingDraftKey\(hydrationDecision\.storageKey\);[\s\S]*setActivePendingDraftMeta\(hydrationDecision\.summary\);[\s\S]*setComposerDraftBySessionId\(\(current\) => setSessionComposerDraft\(current, \{ storageKey: hydrationDecision\.storageKey \}, hydrationDecision\.loadedDraft\.draft\.composer\)\);/s,
    "hydration should update pending draft state and composer draft together from the controller decision",
  );
});
