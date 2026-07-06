import { describe, expect, test } from "bun:test";

import {
  resolveWorkspaceRuntimeIdentity,
  workspaceIdForLocal,
} from "../workspace-id.js";

describe("resolveWorkspaceRuntimeIdentity", () => {
  test("prefers the server workspace id and keeps local aliases for migration", () => {
    const workdir = "/tmp/veslo-project";
    const derivedLocalWorkspaceId = workspaceIdForLocal(workdir);

    const identity = resolveWorkspaceRuntimeIdentity({
      appWorkspaceId: "app-local-ws",
      serverWorkspaceId: "server-ws",
      workdir,
    });

    expect(identity.workspaceId).toBe("server-ws");
    expect(identity.serverWorkspaceId).toBe("server-ws");
    expect(identity.appWorkspaceId).toBe("app-local-ws");
    expect(identity.derivedLocalWorkspaceId).toBe(derivedLocalWorkspaceId);
    expect(identity.legacyWorkspaceIds).toEqual([
      "app-local-ws",
      derivedLocalWorkspaceId,
    ]);
  });

  test("dedupes aliases that already match the primary id", () => {
    const workdir = "/tmp/veslo-project";
    const derivedLocalWorkspaceId = workspaceIdForLocal(workdir);

    const identity = resolveWorkspaceRuntimeIdentity({
      appWorkspaceId: derivedLocalWorkspaceId,
      serverWorkspaceId: derivedLocalWorkspaceId,
      workdir,
    });

    expect(identity.workspaceId).toBe(derivedLocalWorkspaceId);
    expect(identity.legacyWorkspaceIds).toEqual([]);
  });

  test("preserves current derived-local fallback without a server id", () => {
    const workdir = "/tmp/veslo-project";
    const derivedLocalWorkspaceId = workspaceIdForLocal(workdir);

    const identity = resolveWorkspaceRuntimeIdentity({
      workdir,
    });

    expect(identity.workspaceId).toBe(derivedLocalWorkspaceId);
    expect(identity.serverWorkspaceId).toBeNull();
    expect(identity.appWorkspaceId).toBeNull();
    expect(identity.derivedLocalWorkspaceId).toBe(derivedLocalWorkspaceId);
    expect(identity.legacyWorkspaceIds).toEqual([]);
  });
});
