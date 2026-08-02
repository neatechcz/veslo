import { describe, expect, test } from "bun:test";

import {
  projectRuntimeEvidence,
  runtimeEvidenceGenerationFingerprint,
  trustedRuntimeOwnerMatches,
} from "../runtime-evidence.js";

const owner = {
  engineSlotId: "slot-1",
  engineOwnerId: "owner-1",
  enginePid: 101,
  engineStartedAt: 1_000,
  engineBaseUrl: "http://127.0.0.1:50101",
  directoryInstanceEpoch: 2,
  skillViewRevision: "skills-v1",
  authorizationRevision: "auth-v1",
  openCodeConfigDigest: "config-v1",
};

describe("runtime evidence", () => {
  test("requires an exact trusted owner tuple before an engine-loss callback can match", () => {
    expect(trustedRuntimeOwnerMatches(owner, owner)).toBe(true);
    expect(trustedRuntimeOwnerMatches(owner, { ...owner, engineStartedAt: 1_001 })).toBe(false);
    expect(trustedRuntimeOwnerMatches(owner, { ...owner, engineBaseUrl: "http://127.0.0.1:50102" })).toBe(false);
  });

  test("projects a stable safe generation fingerprint without local runtime details", () => {
    const projection = projectRuntimeEvidence({
      workspaceId: "ws-1",
      owner,
      observedAt: "2026-08-01T12:00:00.000Z",
      source: "orchestrator",
      reasonCode: "engine_ready",
    });

    expect(projection).toEqual({
      workspaceId: "ws-1",
      generationFingerprint: runtimeEvidenceGenerationFingerprint(owner),
      readiness: "attached",
      observedAt: "2026-08-01T12:00:00.000Z",
      source: "orchestrator",
      reasonCode: "engine_ready",
    });
    expect(JSON.stringify(projection)).not.toContain(owner.engineBaseUrl);
    expect(JSON.stringify(projection)).not.toContain(owner.engineOwnerId);
    expect(JSON.stringify(projection)).not.toContain(String(owner.enginePid));
  });

  test("marks incomplete owner evidence missing instead of producing a fingerprint", () => {
    expect(projectRuntimeEvidence({
      workspaceId: "ws-1",
      owner: { ...owner, engineOwnerId: null },
      observedAt: "2026-08-01T12:00:00.000Z",
      source: "server",
    })).toEqual({
      workspaceId: "ws-1",
      generationFingerprint: null,
      readiness: "missing",
      observedAt: "2026-08-01T12:00:00.000Z",
      source: "server",
      reasonCode: null,
    });
  });
});
