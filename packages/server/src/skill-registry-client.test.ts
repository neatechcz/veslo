import { createHash } from "node:crypto";

import { afterEach, describe, expect, test } from "bun:test";

import { ApiError } from "./errors.js";
import {
  createRegistrySkill,
  createRegistrySkillInstallation,
  createRegistrySkillReviewRequest,
  createRegistrySkillVersion,
  deleteRegistrySkillInstallation,
  downloadSkillPackageFromRegistry,
  listRegistrySkillInstallations,
  listRegistrySkillVersions,
  listRegistrySkills,
  rejectRegistrySkillReviewRequest,
  replaceRegistryWorkspaceSkillSet,
  restoreRegistrySkillInstallation,
  searchRegistrySkills,
  approveRegistrySkillReviewRequest,
  updateRegistrySkillInstallation,
} from "./skill-registry-client.js";
import { computeSkillPackageSha256 } from "./skill-package-model.js";
import type { RegistrySkillPackageArchive } from "./skill-registry-types.js";

const originalFetch = globalThis.fetch;
const digest = "a".repeat(64);
const skillText = "# Demo\n";
const skillSha256 = createHash("sha256").update(skillText).digest("hex");
const skillBase64 = Buffer.from(skillText).toString("base64");

const skillSummary = () => ({
  id: "skill_demo",
  slug: "demo",
  name: "Demo Skill",
  visibility: "workspace",
  reviewStatus: "approved",
  createdAt: "2026-05-26T10:00:00.000Z",
  updatedAt: "2026-05-26T11:00:00.000Z",
  latestVersion: {
    id: "version_demo_1",
    version: "1.0.0",
    packageSha256: digest,
    createdAt: "2026-05-26T10:30:00.000Z",
  },
});

const listResponse = () => ({ skills: [skillSummary()], nextCursor: null });

const packageResponse = () => ({
  versionId: "version_demo_1",
  skillId: "skill_demo",
  package: (() => {
    const file = {
      path: "SKILL.md",
      sha256: skillSha256,
      sizeBytes: Buffer.byteLength(skillText),
      mediaType: "text/markdown",
      text: skillText,
    };
    const archive = {
      schemaVersion: 1,
      entrypoint: "SKILL.md",
      metadata: { name: "Demo Skill" },
      files: [{ ...file, contentBase64: skillBase64 }],
    } satisfies Omit<RegistrySkillPackageArchive, "packageSha256">;
    return {
      ...archive,
      packageSha256: computeSkillPackageSha256({
        schemaVersion: archive.schemaVersion,
        entrypoint: archive.entrypoint,
        metadata: archive.metadata,
        files: [file],
      }),
    };
  })(),
});

function mockFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

async function expectApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("Expected ApiError");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("skill registry client", () => {
  test("forwards bearer token, org id, and user id headers", async () => {
    const calls = mockFetch(listResponse());

    await listRegistrySkills({
      baseUrl: "https://registry.example/",
      token: "registry-token",
      orgId: "org_123",
      userId: "user_123",
    });

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer registry-token");
    expect(headers.get("x-veslo-den-org-id")).toBe("org_123");
    expect(headers.get("x-veslo-den-user-id")).toBe("user_123");
  });

  test("uses den token as bearer token when registry token is absent", async () => {
    const calls = mockFetch(listResponse());

    await listRegistrySkills({
      baseUrl: "https://registry.example/",
      denToken: "den-token",
    });

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer den-token");
  });

  test("prefers registry token over den token", async () => {
    const calls = mockFetch(listResponse());

    await listRegistrySkills({
      baseUrl: "https://registry.example/",
      token: "registry-token",
      denToken: "den-token",
    });

    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer registry-token");
  });

  test("downloads and validates a skill package", async () => {
    const calls = mockFetch(packageResponse());

    const response = await downloadSkillPackageFromRegistry({
      baseUrl: "https://registry.example",
      versionId: "version_demo_1",
      token: "registry-token",
    });

    expect(calls[0].url).toBe("https://registry.example/v1/skill-versions/version_demo_1/package");
    expect(response.package.files[0].contentBase64).toBe(skillBase64);
  });

  test("encodes search query parameters", async () => {
    const calls = mockFetch({ ...listResponse(), query: "agent workflows" });

    await searchRegistrySkills({
      baseUrl: "https://registry.example",
      query: "agent workflows",
      cursor: "next/cursor",
      limit: 25,
    });

    expect(calls[0].url).toBe(
      "https://registry.example/v1/skills/search?q=agent+workflows&cursor=next%2Fcursor&limit=25",
    );
  });

  test("lists personal global installations with target filters", async () => {
    const calls = mockFetch({
      installations: [
        {
          installationId: "install_personal",
          skillId: "skill_personal",
          versionId: "version_personal",
          enabled: true,
          source: "personal",
          installedAt: "2026-05-26T12:00:00.000Z",
        },
      ],
      nextCursor: null,
    });

    const response = await listRegistrySkillInstallations({
      baseUrl: "https://registry.example",
      source: "personal",
      target: "personal-global",
      token: "registry-token",
    });

    expect(calls[0].url).toBe(
      "https://registry.example/v1/skill-installations?source=personal&target=personal-global",
    );
    expect(response.installations[0].installationId).toBe("install_personal");
  });

  test("creates registry skill, version, and installation with JSON bodies", async () => {
    const responses = [
      { skill: skillSummary() },
      { version: skillSummary().latestVersion },
      {
        installation: {
          installationId: "install_demo",
          skillId: "skill_demo",
          versionId: "version_demo_1",
          enabled: true,
          source: "workspace",
          installedAt: "2026-05-26T12:00:00.000Z",
        },
      },
    ];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(responses.shift());
    }) as typeof fetch;

    await createRegistrySkill({
      baseUrl: "https://registry.example",
      token: "registry-token",
      scope: "workspace",
      name: "demo",
      workspaceId: "workspace_1",
    });
    await createRegistrySkillVersion({
      baseUrl: "https://registry.example",
      token: "registry-token",
      skillId: "skill_demo",
      package: packageResponse().package,
    });
    await createRegistrySkillInstallation({
      baseUrl: "https://registry.example",
      token: "registry-token",
      scope: "workspace",
      skillId: "skill_demo",
      versionId: "version_demo_1",
      workspaceId: "workspace_1",
      updatePolicy: "pinned",
    });

    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      "POST https://registry.example/v1/skills",
      "POST https://registry.example/v1/skills/skill_demo/versions",
      "POST https://registry.example/v1/skill-installations",
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      scope: "workspace",
      name: "demo",
      workspaceId: "workspace_1",
    });
    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
      package: { entrypoint: "SKILL.md" },
    });
    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({
      scope: "workspace",
      skillId: "skill_demo",
      versionId: "version_demo_1",
      workspaceId: "workspace_1",
      updatePolicy: "pinned",
    });
  });

  test("proxies versions, installation mutations, restore, and review requests", async () => {
    const previousFetch = globalThis.fetch;
    const responses = [
      { versions: [skillSummary().latestVersion], nextCursor: null },
      {
        installation: {
          installationId: "install_demo",
          skillId: "skill_demo",
          versionId: "version_demo_2",
          enabled: false,
          source: "workspace",
          installedAt: "2026-05-26T12:00:00.000Z",
        },
      },
      {
        installation: {
          installationId: "install_demo",
          skillId: "skill_demo",
          versionId: "version_demo_2",
          enabled: false,
          source: "workspace",
          installedAt: "2026-05-26T12:00:00.000Z",
        },
      },
      {
        installation: {
          installationId: "install_demo",
          skillId: "skill_demo",
          versionId: "version_demo_2",
          enabled: true,
          source: "workspace",
          installedAt: "2026-05-26T12:00:00.000Z",
        },
      },
      {
        requestId: "review_1",
        skillId: "skill_demo",
        status: "pending_review",
        createdAt: "2026-05-26T12:00:00.000Z",
      },
    ];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(responses.shift());
    }) as typeof fetch;

    try {
      await listRegistrySkillVersions({
        baseUrl: "https://registry.example",
        skillId: "skill_demo",
        cursor: "next/cursor",
        limit: 10,
      });
      await updateRegistrySkillInstallation({
        baseUrl: "https://registry.example",
        installationId: "install_demo",
        enabled: false,
        versionId: "version_demo_2",
        releaseChannel: null,
      });
      await deleteRegistrySkillInstallation({
        baseUrl: "https://registry.example",
        installationId: "install_demo",
      });
      await restoreRegistrySkillInstallation({
        baseUrl: "https://registry.example",
        installationId: "install_demo",
        workspaceId: "workspace_1",
        versionId: "version_demo_2",
      });
      await createRegistrySkillReviewRequest({
        baseUrl: "https://registry.example",
        skillId: "skill_demo",
        versionId: "version_demo_2",
        scope: "org",
        targetOrgId: "org_1",
        reason: "Ready for org use",
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      "GET https://registry.example/v1/skills/skill_demo/versions?cursor=next%2Fcursor&limit=10",
      "PATCH https://registry.example/v1/skill-installations/install_demo",
      "DELETE https://registry.example/v1/skill-installations/install_demo",
      "POST https://registry.example/v1/skill-installations/install_demo/restore",
      "POST https://registry.example/v1/skills/skill_demo/review-requests",
    ]);
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      enabled: false,
      versionId: "version_demo_2",
      releaseChannel: null,
    });
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({
      workspaceId: "workspace_1",
      versionId: "version_demo_2",
    });
    expect(JSON.parse(String(calls[4].init?.body))).toEqual({
      scope: "org",
      versionId: "version_demo_2",
      orgId: "org_1",
      reason: "Ready for org use",
    });
  });

  test("proxies workspace skill-set replacement and review decisions", async () => {
    const previousFetch = globalThis.fetch;
    const responses = [
      {
        workspaceId: "workspace_1",
        skillSetId: "set_1",
        revision: "rev_2",
        skills: [],
      },
      {
        requestId: "review_1",
        skillId: "skill_demo",
        status: "approved",
        createdAt: "2026-05-26T12:00:00.000Z",
        updatedAt: "2026-05-26T12:05:00.000Z",
      },
      {
        requestId: "review_2",
        skillId: "skill_demo",
        status: "rejected",
        createdAt: "2026-05-26T12:00:00.000Z",
        updatedAt: "2026-05-26T12:05:00.000Z",
      },
    ];
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return Response.json(responses.shift());
    }) as typeof fetch;

    try {
      await replaceRegistryWorkspaceSkillSet({
        baseUrl: "https://registry.example",
        workspaceId: "workspace_1",
        targetOrgId: "org_1",
        releaseChannel: "stable",
        skills: [{ installationId: "install_1", desiredVersionId: "version_2", releaseChannel: null }],
      });
      await approveRegistrySkillReviewRequest({
        baseUrl: "https://registry.example",
        requestId: "review_1",
        reviewerNote: "Approved",
        releaseChannel: "stable",
      });
      await rejectRegistrySkillReviewRequest({
        baseUrl: "https://registry.example",
        requestId: "review_2",
        reviewerNote: "Needs docs",
      });
    } finally {
      globalThis.fetch = previousFetch;
    }

    expect(calls.map((call) => `${call.init?.method ?? "GET"} ${call.url}`)).toEqual([
      "PATCH https://registry.example/v1/workspaces/workspace_1/skill-set",
      "POST https://registry.example/v1/skill-review-requests/review_1/approve",
      "POST https://registry.example/v1/skill-review-requests/review_2/reject",
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      orgId: "org_1",
      releaseChannel: "stable",
      skills: [{ installationId: "install_1", desiredVersionId: "version_2", releaseChannel: null }],
    });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      reviewerNote: "Approved",
      releaseChannel: "stable",
    });
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      reviewerNote: "Needs docs",
    });
  });

  test("preserves base URL path prefixes", async () => {
    const calls = mockFetch(listResponse());

    await listRegistrySkills({
      baseUrl: "https://registry.example/api/",
    });

    expect(calls[0].url).toBe("https://registry.example/api/v1/skills");
  });

  test.each(["https://registry.example/api?token=secret", "https://registry.example/api#secret"])(
    "rejects base URLs with query or hash: %s",
    async (baseUrl) => {
      const error = await expectApiError(listRegistrySkills({ baseUrl }));

      expect(error.status).toBe(500);
      expect(error.code).toBe("skill_registry_misconfigured");
      expect(JSON.stringify(error.details)).not.toContain("secret");
    },
  );

  test("normalizes malformed base URL errors", async () => {
    const error = await expectApiError(listRegistrySkills({ baseUrl: "not a url" }));

    expect(error.status).toBe(500);
    expect(error.code).toBe("skill_registry_misconfigured");
    expect(error.details).toEqual({ url: "not a url" });
  });

  test("rejects base URLs with credentials without leaking them", async () => {
    const error = await expectApiError(listRegistrySkills({ baseUrl: "https://user:secret@registry.example/api" }));

    expect(error.status).toBe(500);
    expect(error.code).toBe("skill_registry_misconfigured");
    expect(error.details).toEqual({ url: "https://registry.example/api" });
    expect(JSON.stringify(error.details)).not.toContain("secret");
  });

  test("normalizes invalid JSON without leaking response body", async () => {
    globalThis.fetch = (async () =>
      new Response("{ token: registry-token", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const error = await expectApiError(listRegistrySkills({ baseUrl: "https://registry.example" }));

    expect(error.status).toBe(502);
    expect(error.code).toBe("skill_registry_invalid_payload");
    expect(JSON.stringify(error.details)).not.toContain("registry-token");
  });

  test("normalizes invalid validated payload without leaking payload content", async () => {
    mockFetch({ skills: [{ token: "registry-token" }] });

    const error = await expectApiError(listRegistrySkills({ baseUrl: "https://registry.example" }));

    expect(error.status).toBe(502);
    expect(error.code).toBe("skill_registry_invalid_payload");
    expect(JSON.stringify(error.details)).not.toContain("registry-token");
  });

  test("normalizes network failures without exposing token-bearing messages", async () => {
    globalThis.fetch = (async () => {
      throw new Error("failed with registry-token in upstream context");
    }) as unknown as typeof fetch;

    const error = await expectApiError(
      listRegistrySkills({
        baseUrl: "https://registry.example",
        token: "registry-token",
      }),
    );

    expect(error.status).toBe(502);
    expect(error.code).toBe("skill_registry_fetch_failed");
    expect(JSON.stringify(error.details)).not.toContain("registry-token");
  });

  test.each([
    [401, "skill_registry_unauthorized"],
    [403, "skill_registry_forbidden"],
    [404, "skill_registry_not_found"],
  ] as const)("normalizes %i registry responses", async (status, code) => {
    mockFetch({ code: "upstream", message: "nope" }, status);

    await expect(
      listRegistrySkills({
        baseUrl: "https://registry.example",
      }),
    ).rejects.toMatchObject({
      status,
      code,
    } satisfies Partial<ApiError>);
  });

  test("does not expose raw upstream body in ApiError details", async () => {
    mockFetch({ code: "upstream_denied", message: "echoed registry-token" }, 403);

    const error = await expectApiError(
      listRegistrySkills({
        baseUrl: "https://registry.example",
        token: "registry-token",
      }),
    );

    expect(error.details).toEqual({
      url: "https://registry.example/v1/skills",
      status: 403,
    });
    expect(JSON.stringify(error.details)).not.toContain("registry-token");
  });

  test("drops unsafe upstream codes from ApiError details", async () => {
    mockFetch({ code: "registry-token", message: "echoed registry-token" }, 403);

    const error = await expectApiError(
      listRegistrySkills({
        baseUrl: "https://registry.example",
        token: "registry-token",
      }),
    );

    expect(error.details).toEqual({
      url: "https://registry.example/v1/skills",
      status: 403,
    });
    expect(JSON.stringify(error.details)).not.toContain("registry-token");
  });
});
