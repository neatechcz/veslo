import { describe, expect, test } from "bun:test";

import { ApiError } from "./errors.js";
import type { SoulDocument, SoulVersion } from "./soul-memory.js";
import {
  getOrganizationSoul,
  getUserSoul,
  getSoulVersion,
  listSoulVersions,
  restoreSoulVersion,
  updateOrganizationSoul,
  updateUserSoul,
} from "./soul-den-client.js";

type FetchCall = { url: string; init?: RequestInit };

const userDocument = (): SoulDocument => ({
  id: "soul_user_123",
  scope: "user",
  ownerId: "user_123",
  currentVersionId: "version_1",
  heartbeatEnabled: true,
  versions: [version("version_1")],
});

const organizationDocument = (): SoulDocument => ({
  id: "soul_org_123",
  scope: "organization",
  ownerId: "org_123",
  currentVersionId: "version_1",
  heartbeatEnabled: false,
  versions: [version("version_1")],
});

const version = (id: string): SoulVersion => ({
  id,
  content: `Content ${id}`,
  changeSummary: "Updated memory",
  createdAt: "2026-06-05T10:00:00.000Z",
  createdBy: "user_123",
  source: "manual",
  baseVersionId: null,
  restoreSourceVersionId: null,
});

function mockFetch(response: unknown, status = 200): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  const mockedFetch: typeof fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetch: mockedFetch };
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

describe("soul Den client", () => {
  test("User Soul GET sends Den bearer token and user/org context", async () => {
    const { calls, fetch } = mockFetch(userDocument());

    await getUserSoul({
      baseUrl: "https://den.example/",
      denToken: "den-token",
      orgId: "org_123",
      userId: "user_123",
      requestId: "request_123",
      fetch,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://den.example/v1/soul/user");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer den-token");
    expect(headers.get("x-veslo-org-id")).toBe("org_123");
    expect(headers.get("x-veslo-user-id")).toBe("user_123");
    expect(headers.get("x-request-id")).toBe("request_123");
  });

  test("Organization Soul PATCH sends Den bearer token and org id", async () => {
    const { calls, fetch } = mockFetch(organizationDocument());

    await updateOrganizationSoul({
      baseUrl: "https://den.example",
      denToken: "den-token",
      orgId: "org_123",
      userId: "user_123",
      fetch,
      content: "New org memory",
      changeSummary: "Update org memory",
      baseVersionId: "version_1",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://den.example/v1/soul/organization");
    expect(calls[0].init?.method).toBe("PATCH");
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("authorization")).toBe("Bearer den-token");
    expect(headers.get("x-veslo-org-id")).toBe("org_123");
    expect(headers.get("x-veslo-user-id")).toBe("user_123");
    await expect(new Response(calls[0].init?.body).json()).resolves.toEqual({
      content: "New org memory",
      changeSummary: "Update org memory",
      baseVersionId: "version_1",
    });
  });

  test("Organization update preserves 403 when Den rejects non-admin writes", async () => {
    const { fetch } = mockFetch({ code: "organization_soul_admin_required" }, 403);

    const error = await expectApiError(updateOrganizationSoul({
      baseUrl: "https://den.example",
      denToken: "den-token",
      orgId: "org_123",
      userId: "user_123",
      fetch,
      content: "New org memory",
      changeSummary: "Update org memory",
      baseVersionId: "version_1",
    }));

    expect(error.status).toBe(403);
    expect(error.code).toBe("soul_den_forbidden");
  });

  test("stale baseVersionId returns conflict instead of generic fetch error", async () => {
    const { fetch } = mockFetch({ code: "stale_base_version" }, 409);

    const error = await expectApiError(updateUserSoul({
      baseUrl: "https://den.example",
      denToken: "den-token",
      orgId: "org_123",
      userId: "user_123",
      fetch,
      content: "New user memory",
      changeSummary: "Update user memory",
      baseVersionId: "old_version",
    }));

    expect(error.status).toBe(409);
    expect(error.code).toBe("soul_den_conflict");
  });

  test("supports user and organization version routes", async () => {
    const { calls, fetch } = mockFetch({ versions: [version("version_1"), version("version_2")], nextCursor: null });

    await listSoulVersions({
      baseUrl: "https://den.example",
      denToken: "den-token",
      orgId: "org_123",
      userId: "user_123",
      scope: "organization",
      cursor: "cursor/1",
      limit: 10,
      fetch,
    });

    expect(calls[0].url).toBe(
      "https://den.example/v1/soul/organization/versions?cursor=cursor%2F1&limit=10",
    );
  });

  test("supports get and restore version routes", async () => {
    const getMock = mockFetch(version("version_2"));
    await getSoulVersion({
      baseUrl: "https://den.example",
      denToken: "den-token",
      orgId: "org_123",
      userId: "user_123",
      scope: "user",
      versionId: "version/2",
      fetch: getMock.fetch,
    });
    expect(getMock.calls[0].url).toBe("https://den.example/v1/soul/user/versions/version%2F2");

    const restoreMock = mockFetch(userDocument());
    await restoreSoulVersion({
      baseUrl: "https://den.example",
      denToken: "den-token",
      orgId: "org_123",
      userId: "user_123",
      scope: "user",
      versionId: "version/2",
      changeSummary: "Restore old memory",
      fetch: restoreMock.fetch,
    });
    expect(restoreMock.calls[0].url).toBe("https://den.example/v1/soul/user/versions/version%2F2/restore");
    expect(restoreMock.calls[0].init?.method).toBe("POST");
  });
});
