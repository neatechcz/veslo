import { describe, expect, test } from "bun:test";
import {
  createSoulVersion,
  currentSoulVersion,
  resolveEffectiveSoul,
  restoreSoulVersion,
  type SoulDocument,
} from "./soul-memory.js";

const createdAt = "2026-06-05T10:00:00.000Z";

function version(overrides: Partial<SoulDocument["versions"][number]> = {}): SoulDocument["versions"][number] {
  return {
    id: "v1",
    content: "# User Soul",
    changeSummary: "Initial",
    createdAt,
    createdBy: "user_1",
    source: "manual",
    baseVersionId: null,
    restoreSourceVersionId: null,
    ...overrides,
  };
}

function document(overrides: Partial<SoulDocument> = {}): SoulDocument {
  return {
    id: "soul_user_1",
    scope: "user",
    ownerId: "user_1",
    currentVersionId: "v1",
    heartbeatEnabled: false,
    versions: [version()],
    ...overrides,
  };
}

describe("createSoulVersion", () => {
  test("appends an immutable version and advances currentVersionId", () => {
    const doc = document();

    const next = createSoulVersion(doc, {
      id: "v2",
      content: "# User Soul\n- CFO context",
      changeSummary: "Add CFO context",
      createdAt: "2026-06-05T10:10:00.000Z",
      createdBy: "user_1",
      source: "api",
      baseVersionId: "v1",
    });

    expect(next).not.toBe(doc);
    expect(next.versions).not.toBe(doc.versions);
    expect(next.currentVersionId).toBe("v2");
    expect(next.versions).toHaveLength(2);
    expect(next.versions.at(-1)).toEqual({
      id: "v2",
      content: "# User Soul\n- CFO context",
      changeSummary: "Add CFO context",
      createdAt: "2026-06-05T10:10:00.000Z",
      createdBy: "user_1",
      source: "api",
      baseVersionId: "v1",
      restoreSourceVersionId: null,
    });
    expect(doc.currentVersionId).toBe("v1");
    expect(doc.versions).toEqual([version()]);
  });

  test("rejects stale baseVersionId when the caller edits against an old current version", () => {
    const doc = document({
      currentVersionId: "v2",
      versions: [
        version(),
        version({
          id: "v2",
          content: "# User Soul\n- Current context",
          changeSummary: "Current",
          createdAt: "2026-06-05T10:05:00.000Z",
          baseVersionId: "v1",
        }),
      ],
    });

    expect(() =>
      createSoulVersion(doc, {
        id: "v3",
        content: "# User Soul\n- Stale draft",
        changeSummary: "Save stale draft",
        createdAt: "2026-06-05T10:10:00.000Z",
        createdBy: "user_1",
        source: "manual",
        baseVersionId: "v1",
      }),
    ).toThrow(/stale baseVersionId/i);
  });
});

describe("restoreSoulVersion", () => {
  test("creates a new current version instead of mutating history", () => {
    const doc = document({
      currentVersionId: "v2",
      versions: [
        version({ content: "# User Soul\n- Original" }),
        version({
          id: "v2",
          content: "# User Soul\n- Current",
          changeSummary: "Current",
          createdAt: "2026-06-05T10:05:00.000Z",
          baseVersionId: "v1",
        }),
      ],
    });

    const next = restoreSoulVersion(doc, {
      id: "v3",
      restoreSourceVersionId: "v1",
      createdAt: "2026-06-05T10:20:00.000Z",
      createdBy: "user_1",
      changeSummary: "Restore original",
    });

    expect(next.currentVersionId).toBe("v3");
    expect(next.versions).toHaveLength(3);
    expect(next.versions.at(-1)).toEqual({
      id: "v3",
      content: "# User Soul\n- Original",
      changeSummary: "Restore original",
      createdAt: "2026-06-05T10:20:00.000Z",
      createdBy: "user_1",
      source: "restore",
      baseVersionId: "v2",
      restoreSourceVersionId: "v1",
    });
    expect(doc.currentVersionId).toBe("v2");
    expect(doc.versions).toHaveLength(2);
  });
});

describe("currentSoulVersion", () => {
  test("returns the current version or null", () => {
    expect(currentSoulVersion(document())).toEqual(version());
    expect(currentSoulVersion(document({ currentVersionId: null }))).toBeNull();
    expect(currentSoulVersion(document({ currentVersionId: "missing" }))).toBeNull();
  });
});

describe("resolveEffectiveSoul", () => {
  test("composes Organization, User, Workspace content in order and skips missing/currentless documents", () => {
    const organization = document({
      id: "soul_org_1",
      scope: "organization",
      ownerId: "org_1",
      versions: [version({ id: "org_v1", content: "# Organization Soul" })],
      currentVersionId: "org_v1",
    });
    const user = document({
      id: "soul_user_1",
      scope: "user",
      ownerId: "user_1",
      versions: [version({ id: "user_v1", content: "# User Soul" })],
      currentVersionId: "user_v1",
    });
    const workspace = document({
      id: "soul_workspace_1",
      scope: "workspace",
      ownerId: "workspace_1",
      versions: [version({ id: "workspace_v1", content: "# Workspace Soul" })],
      currentVersionId: "workspace_v1",
    });
    const currentlessUser = document({
      id: "soul_user_empty",
      currentVersionId: null,
      versions: [version({ id: "user_v1", content: "# Ignored User Soul" })],
    });

    expect(resolveEffectiveSoul({ organization, user, workspace })).toBe(
      "# Organization Soul\n\n# User Soul\n\n# Workspace Soul",
    );
    expect(resolveEffectiveSoul({ organization: null, user: currentlessUser, workspace })).toBe(
      "# Workspace Soul",
    );
  });
});
