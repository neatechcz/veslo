# OpenCode Project Session Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route the non-sandbox shared OpenCode engine through the OpenCode 1.17.4 project/session API while keeping sandboxed and pooled Veslo workspaces on the existing per-workspace directory-scoped engine model.

**Architecture:** Add an orchestrator adapter that maps Veslo workspace-scoped URLs to OpenCode project-scoped URLs only when the active topology is `shared-unsandboxed` and `VESLO_OPENCODE_PROJECT_SESSIONS=1` is set. Sandbox, WSL sandbox, pooled per-workspace engines, remote workspaces, and default shared-engine compatibility mode keep the current `/session` plus directory routing. Veslo workspace IDs remain the product identity; OpenCode project IDs are cached upstream routing metadata.

**Tech Stack:** TypeScript, Bun tests, Veslo orchestrator proxy, Veslo server conversation API, OpenCode 1.17.4 sidecar, `@opencode-ai/sdk@1.17.4`, Windows/WSL path handling.

---

## Source Contract

Use the tagged OpenCode 1.17.4 project spec as the route source:

```text
https://raw.githubusercontent.com/anomalyco/opencode/v1.17.4/specs/project.md
```

The spec states the goal is one OpenCode instance running sessions for multiple projects and worktrees. The project/session API surface relevant to Veslo is:

```text
GET    /project
POST   /project/init
GET    /project/:projectID/session
POST   /project/:projectID/session
GET    /project/:projectID/session/:sessionID
DELETE /project/:projectID/session/:sessionID
POST   /project/:projectID/session/:sessionID/init
POST   /project/:projectID/session/:sessionID/abort
POST   /project/:projectID/session/:sessionID/share
DELETE /project/:projectID/session/:sessionID/share
POST   /project/:projectID/session/:sessionID/compact
GET    /project/:projectID/session/:sessionID/message
GET    /project/:projectID/session/:sessionID/message/:messageID
POST   /project/:projectID/session/:sessionID/message
POST   /project/:projectID/session/:sessionID/revert
POST   /project/:projectID/session/:sessionID/unrevert
POST   /project/:projectID/session/:sessionID/permission/:permissionID
GET    /project/:projectID/session/:sessionID/find/file
GET    /project/:projectID/session/:sessionID/file
GET    /project/:projectID/session/:sessionID/file/status
GET    /provider?directory=
GET    /config?directory=
GET    /project/:projectID/agent?directory=
GET    /project/:projectID/find/file?directory=
```

Legacy routes that are not present in this spec keep directory-scoped routing:

```text
GET    /global/health
GET    /event
GET    /session/status
POST   /session/:sessionID/command
POST   /session/:sessionID/shell
POST   /session/:sessionID/summarize
GET    /mcp
GET    /permission
GET    /lsp
```

## Required Runtime Matrix

| Sandbox / topology | `VESLO_SHARED_OPENCODE_ENGINE` | `VESLO_OPENCODE_PROJECT_SESSIONS` | Expected behavior |
| --- | --- | --- | --- |
| default pooled | unset | unset | Existing pooled `/session` routing |
| default pooled | unset | `1` | Startup error: project sessions require shared non-sandbox topology |
| sandbox active | `1` | unset | Startup error from existing shared-engine guard |
| sandbox active | `1` | `1` | Startup error before engine spawn |
| WSL sandbox active | `1` | `1` | Startup error before WSL provision/shared engine spawn |
| non-sandbox shared | `1` | unset | Existing shared compatibility mode with `/session` and directory |
| non-sandbox shared | `1` | `1` | New project/session adapter mode |

This plan intentionally keeps the new OpenCode project model out of sandboxed runtimes. A sandboxed workspace can still use its own per-workspace OpenCode process through the existing model.

## File Structure

Create:

- `packages/orchestrator/src/opencode-project-registry.ts`
  - Owns project list/init, project directory matching, project ID cache, and in-flight coalescing.
- `packages/orchestrator/src/opencode-project-session-router.ts`
  - Pure route classifier and URL/body rewrite plan for project-scoped upstream calls.
- `packages/orchestrator/src/tests/opencode-project-registry.test.ts`
  - Tests project init/list/cache behavior with fake fetch.
- `packages/orchestrator/src/tests/opencode-project-session-router.test.ts`
  - Tests route mapping and pass-through routes.
- `packages/orchestrator/scripts/opencode-project-session-smoke.mjs`
  - Starts the bundled sidecar and verifies project/session route availability against real OpenCode 1.17.4.
- `docs/dev/opencode-project-session-model.md`
  - Developer docs for flags, sandbox split, smoke checks, and rollback.

Modify:

- `packages/orchestrator/src/engine-topology.ts`
  - Add project-session routing flag resolver and guard.
- `packages/orchestrator/src/tests/engine-topology.test.ts`
  - Add guard tests for `VESLO_OPENCODE_PROJECT_SESSIONS`.
- `packages/orchestrator/src/cli.ts`
  - Wire registry and router into `/workspace/:id/opencode/*` proxy path and health output.
- `packages/orchestrator/src/opencode-proxy-target.ts`
  - Return enough target metadata for project router integration.
- `packages/orchestrator/src/run-activity-probe.ts`
  - Route message reads through the same project router when enabled.
- `packages/orchestrator/src/tests/opencode-proxy-target.test.ts`
  - Extend shared-mode assertions if target metadata changes.
- `packages/orchestrator/package.json`
  - Add the real sidecar smoke script.
- `packages/server/src/tests/server-conversations.test.ts`
  - Keep server public contract stable and add a mode-aware orchestrator path assertion.
- `packages/server/src/tests/server-stale-active-run.integration.test.ts`
  - Assert server still calls `/workspace/:id/opencode/session/...` and lets the orchestrator adapt upstream.

Do not modify these files for the first project-session implementation:

- `packages/app/src/app/lib/opencode.ts`
- `packages/opencode-router/src/bridge.ts`
- `packages/opencode-router/src/opencode.ts`

They already call the workspace-scoped Veslo base URL. The orchestrator adapter is the first integration layer.

---

### Task 1: Add Project-Session Mode Guard

**Files:**

- Modify: `packages/orchestrator/src/engine-topology.ts`
- Modify: `packages/orchestrator/src/tests/engine-topology.test.ts`
- Modify: `packages/orchestrator/src/cli.ts`

- [ ] **Step 1: Add failing tests for the new flag**

Add these cases to `packages/orchestrator/src/tests/engine-topology.test.ts`:

```ts
it("keeps project session routing disabled by default", () => {
  const topology = resolveEngineTopology({
    env: {},
    sandboxKind: "none",
  });

  expect(topology.mode).toBe("pooled-per-workspace");
  expect(topology.projectSessions).toBe(false);
});

it("enables project session routing only for shared unsandboxed topology", () => {
  const topology = resolveEngineTopology({
    env: {
      VESLO_DISABLE_SANDBOX: "1",
      VESLO_SHARED_OPENCODE_ENGINE: "1",
      VESLO_OPENCODE_PROJECT_SESSIONS: "1",
    },
    sandboxKind: "none",
  });

  expect(topology.mode).toBe("shared-unsandboxed");
  expect(topology.projectSessions).toBe(true);
});

it("rejects project session routing without shared engine", () => {
  expect(() =>
    resolveEngineTopology({
      env: {
        VESLO_DISABLE_SANDBOX: "1",
        VESLO_OPENCODE_PROJECT_SESSIONS: "1",
      },
      sandboxKind: "none",
    }),
  ).toThrow(/VESLO_OPENCODE_PROJECT_SESSIONS=1 requires VESLO_SHARED_OPENCODE_ENGINE=1/i);
});

it("rejects project session routing when sandbox is active", () => {
  expect(() =>
    resolveEngineTopology({
      env: {
        VESLO_DISABLE_SANDBOX: "1",
        VESLO_SHARED_OPENCODE_ENGINE: "1",
        VESLO_OPENCODE_PROJECT_SESSIONS: "1",
      },
      sandboxKind: "windows-wsl2",
    }),
  ).toThrow(/project session routing is only supported in shared-unsandboxed topology/i);
});
```

- [ ] **Step 2: Run the guard tests and confirm failure**

Run:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/engine-topology.test.ts
```

Expected before implementation: FAIL because `projectSessions` is missing.

- [ ] **Step 3: Implement the guard**

Update `packages/orchestrator/src/engine-topology.ts`:

```ts
export type EngineTopology = {
  mode: EngineTopologyMode;
  reason: string;
  sharedRequested: boolean;
  projectSessions: boolean;
};

export function opencodeProjectSessionsRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.VESLO_OPENCODE_PROJECT_SESSIONS;
  return value === "1" || value === "true";
}
```

Inside `resolveEngineTopology`, after reading the shared-engine request:

```ts
const projectSessionsRequested = opencodeProjectSessionsRequested(env);

if (projectSessionsRequested && !requested) {
  throw new Error(
    "VESLO_OPENCODE_PROJECT_SESSIONS=1 requires VESLO_SHARED_OPENCODE_ENGINE=1. OpenCode project sessions are only supported by the shared non-sandbox engine.",
  );
}
```

When returning pooled mode:

```ts
return {
  mode: "pooled-per-workspace",
  reason: "shared engine not requested",
  sharedRequested: requested,
  projectSessions: false,
};
```

When returning shared mode:

```ts
return {
  mode: "shared-unsandboxed",
  reason: "explicit non-sandbox shared engine requested",
  sharedRequested: requested,
  projectSessions: projectSessionsRequested,
};
```

Before returning shared mode, enforce the sandbox split:

```ts
if (projectSessionsRequested && input.sandboxKind !== "none") {
  throw new Error(
    "OpenCode project session routing is only supported in shared-unsandboxed topology. Sandbox and WSL sandbox runtimes must keep per-workspace engines.",
  );
}
```

- [ ] **Step 4: Add CLI flag**

In `packages/orchestrator/src/cli.ts`, add the help line:

```ts
"  --opencode-project-sessions  Route shared non-sandbox OpenCode through /project/:projectID/session",
```

Read the flag next to `shared-opencode-engine`:

```ts
const opencodeProjectSessionsRequested = readBool(
  args.flags,
  "opencode-project-sessions",
  false,
  "VESLO_OPENCODE_PROJECT_SESSIONS",
);
```

Pass it into `resolveEngineTopology`:

```ts
VESLO_OPENCODE_PROJECT_SESSIONS: opencodeProjectSessionsRequested ? "1" : "0",
```

- [ ] **Step 5: Verify**

Run:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/engine-topology.test.ts
pnpm --filter veslo-orchestrator typecheck
```

Expected: PASS.

Commit:

```powershell
git add packages/orchestrator/src/engine-topology.ts packages/orchestrator/src/tests/engine-topology.test.ts packages/orchestrator/src/cli.ts
git commit -m "orchestrator: guard opencode project session mode"
```

---

### Task 2: Build OpenCode Project Registry

**Files:**

- Create: `packages/orchestrator/src/opencode-project-registry.ts`
- Create: `packages/orchestrator/src/tests/opencode-project-registry.test.ts`
- Modify: `packages/orchestrator/src/opencode-project-api.ts`

- [ ] **Step 1: Add failing registry tests**

Create `packages/orchestrator/src/tests/opencode-project-registry.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { OpenCodeProjectRegistry } from "../opencode-project-registry";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenCodeProjectRegistry", () => {
  it("reuses a listed project whose directory matches the workspace path", async () => {
    const calls: string[] = [];
    const registry = new OpenCodeProjectRegistry({
      baseUrl: "http://opencode.local",
      headers: { authorization: "Basic token" },
      fetchImpl: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return jsonResponse([{ id: "proj-a", directory: "C:/repo/a" }]);
      },
    });

    const resolved = await registry.ensureProjectForDirectory("C:/repo/a");

    expect(resolved.projectID).toBe("proj-a");
    expect(resolved.source).toBe("listed");
    expect(calls).toEqual(["GET http://opencode.local/project"]);
  });

  it("initializes and validates a project when none is listed", async () => {
    const calls: string[] = [];
    const registry = new OpenCodeProjectRegistry({
      baseUrl: "http://opencode.local/",
      headers: { authorization: "Basic token" },
      fetchImpl: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (String(url).startsWith("http://opencode.local/project/init")) {
          expect(init?.method).toBe("POST");
          expect((init?.headers as Record<string, string>)["x-opencode-directory"]).toBe("C:/repo/b");
          return jsonResponse({ id: "proj-b", directory: "C:/repo/b" });
        }
        return jsonResponse([]);
      },
    });

    const resolved = await registry.ensureProjectForDirectory("C:/repo/b");

    expect(resolved.projectID).toBe("proj-b");
    expect(resolved.source).toBe("initialized");
    expect(calls).toEqual([
      "GET http://opencode.local/project",
      "POST http://opencode.local/project/init?directory=C%3A%2Frepo%2Fb",
    ]);
  });

  it("coalesces concurrent init calls for the same directory", async () => {
    let initCount = 0;
    const registry = new OpenCodeProjectRegistry({
      baseUrl: "http://opencode.local",
      fetchImpl: async (url, init) => {
        if (String(url).startsWith("http://opencode.local/project/init")) {
          initCount += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return jsonResponse({ id: "proj-c", directory: "C:/repo/c" });
        }
        return jsonResponse([]);
      },
    });

    const [first, second] = await Promise.all([
      registry.ensureProjectForDirectory("C:/repo/c"),
      registry.ensureProjectForDirectory("C:/repo/c/"),
    ]);

    expect(first.projectID).toBe("proj-c");
    expect(second.projectID).toBe("proj-c");
    expect(initCount).toBe(1);
  });

  it("throws when project init returns a project for a different directory", async () => {
    const registry = new OpenCodeProjectRegistry({
      baseUrl: "http://opencode.local",
      fetchImpl: async (url) => {
        if (String(url).startsWith("http://opencode.local/project/init")) {
          return jsonResponse({ id: "wrong", directory: "C:/repo/other" });
        }
        return jsonResponse([]);
      },
    });

    await expect(registry.ensureProjectForDirectory("C:/repo/d")).rejects.toThrow(
      /did not match requested directory/i,
    );
  });
});
```

- [ ] **Step 2: Run the registry tests and confirm failure**

Run:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/opencode-project-registry.test.ts
```

Expected before implementation: FAIL because the module does not exist.

- [ ] **Step 3: Implement registry types and helpers**

Create `packages/orchestrator/src/opencode-project-registry.ts`:

```ts
import { normalize } from "node:path";

export type OpenCodeProjectRegistryFetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

export type OpenCodeProjectSummary = {
  id: string;
  directory?: string;
  raw: Record<string, unknown>;
};

export type OpenCodeProjectResolution = {
  projectID: string;
  directory: string;
  source: "cache" | "listed" | "initialized";
  project: OpenCodeProjectSummary;
};

type OpenCodeProjectRegistryOptions = {
  baseUrl: string;
  headers?: Record<string, string>;
  fetchImpl?: OpenCodeProjectRegistryFetch;
  timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeDirectoryKey(directory: string): string {
  const trimmed = directory.trim().replace(/[\\/]+$/, "");
  const normalized = normalize(trimmed).replace(/\\/g, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function projectDirectory(project: Record<string, unknown>): string | undefined {
  return (
    readString(project, "directory") ??
    readString(project, "path") ??
    readString(project, "root") ??
    readString(project, "cwd") ??
    readString(project, "worktree")
  );
}

function projectID(project: Record<string, unknown>): string | undefined {
  return readString(project, "id") ?? readString(project, "projectID");
}

function normalizeProject(value: unknown): OpenCodeProjectSummary | null {
  if (!isRecord(value)) return null;
  const id = projectID(value);
  if (!id) return null;
  return {
    id,
    directory: projectDirectory(value),
    raw: value,
  };
}
```

- [ ] **Step 4: Implement list/init/cache**

Add the registry class to the same file:

```ts
export class OpenCodeProjectRegistry {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: OpenCodeProjectRegistryFetch;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, OpenCodeProjectResolution>();
  private readonly pending = new Map<string, Promise<OpenCodeProjectResolution>>();

  constructor(options: OpenCodeProjectRegistryOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : 5_000;
  }

  snapshot(): { cachedProjects: number; pendingProjects: number } {
    return {
      cachedProjects: this.cache.size,
      pendingProjects: this.pending.size,
    };
  }

  async ensureProjectForDirectory(directory: string): Promise<OpenCodeProjectResolution> {
    const normalizedDirectory = directory.trim();
    if (!normalizedDirectory) {
      throw new Error("OpenCode project directory is required");
    }
    const key = normalizeDirectoryKey(normalizedDirectory);
    const cached = this.cache.get(key);
    if (cached) return { ...cached, source: "cache" };

    const existing = this.pending.get(key);
    if (existing) return await existing;

    const pending = this.resolveProject(normalizedDirectory, key).finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, pending);
    return await pending;
  }

  private async resolveProject(directory: string, key: string): Promise<OpenCodeProjectResolution> {
    const listed = await this.listProjects();
    const match = listed.find((project) => {
      if (!project.directory) return false;
      return normalizeDirectoryKey(project.directory) === key;
    });
    if (match) {
      const resolution: OpenCodeProjectResolution = {
        projectID: match.id,
        directory,
        source: "listed",
        project: match,
      };
      this.cache.set(key, resolution);
      return resolution;
    }

    const initialized = await this.initProject(directory);
    if (!initialized.directory || normalizeDirectoryKey(initialized.directory) !== key) {
      throw new Error(
        `OpenCode project init returned project '${initialized.id}' but did not match requested directory '${directory}'`,
      );
    }
    const resolution: OpenCodeProjectResolution = {
      projectID: initialized.id,
      directory,
      source: "initialized",
      project: initialized,
    };
    this.cache.set(key, resolution);
    return resolution;
  }

  private async listProjects(): Promise<OpenCodeProjectSummary[]> {
    const response = await this.fetchImpl(`${this.baseUrl}/project`, {
      headers: this.headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`OpenCode project list failed with HTTP ${response.status}`);
    }
    const body = await response.json();
    const items = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.data) ? body.data : [];
    return items.flatMap((item) => {
      const project = normalizeProject(item);
      return project ? [project] : [];
    });
  }

  private async initProject(directory: string): Promise<OpenCodeProjectSummary> {
    const url = new URL(`${this.baseUrl}/project/init`);
    url.searchParams.set("directory", directory);
    const response = await this.fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        ...this.headers,
        "x-opencode-directory": directory,
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`OpenCode project init failed with HTTP ${response.status}`);
    }
    const project = normalizeProject(await response.json());
    if (!project) {
      throw new Error("OpenCode project init returned an invalid project payload");
    }
    return project;
  }
}
```

- [ ] **Step 5: Keep the probe but stop treating it as the routing source**

Leave `probeOpenCodeProjectApi` in `packages/orchestrator/src/opencode-project-api.ts` for diagnostics. Do not import it from the new router. The new routing source is `OpenCodeProjectRegistry`.

- [ ] **Step 6: Verify**

Run:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/opencode-project-registry.test.ts
pnpm --filter veslo-orchestrator typecheck
```

Expected: PASS.

Commit:

```powershell
git add packages/orchestrator/src/opencode-project-registry.ts packages/orchestrator/src/tests/opencode-project-registry.test.ts packages/orchestrator/src/opencode-project-api.ts
git commit -m "orchestrator: add opencode project registry"
```

---

### Task 3: Build Project Session Route Adapter

**Files:**

- Create: `packages/orchestrator/src/opencode-project-session-router.ts`
- Create: `packages/orchestrator/src/tests/opencode-project-session-router.test.ts`

- [ ] **Step 1: Add failing route mapping tests**

Create `packages/orchestrator/src/tests/opencode-project-session-router.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { resolveProjectSessionRoute } from "../opencode-project-session-router";

const base = {
  projectID: "proj-1",
  directory: "C:/repo/a",
};

describe("resolveProjectSessionRoute", () => {
  it("maps session list to project sessions", () => {
    expect(resolveProjectSessionRoute({ ...base, method: "GET", path: "/session", search: "" })).toMatchObject({
      mode: "project",
      targetPath: "/project/proj-1/session",
      targetSearch: "",
    });
  });

  it("maps session create and injects directory into the body", () => {
    const route = resolveProjectSessionRoute({
      ...base,
      method: "POST",
      path: "/session",
      search: "",
    });

    expect(route.mode).toBe("project");
    expect(route.targetPath).toBe("/project/proj-1/session");
    expect(route.rewriteJsonBody?.({ title: "Hello" })).toEqual({
      title: "Hello",
      directory: "C:/repo/a",
    });
  });

  it("maps message reads and preserves non-directory query params", () => {
    expect(
      resolveProjectSessionRoute({
        ...base,
        method: "GET",
        path: "/session/sess-1/message",
        search: "?limit=200&directory=C%3A%2Frepo%2Fa",
      }),
    ).toMatchObject({
      mode: "project",
      targetPath: "/project/proj-1/session/sess-1/message",
      targetSearch: "?limit=200",
    });
  });

  it("maps prompt_async to the project message endpoint with unchanged JSON body", () => {
    const route = resolveProjectSessionRoute({
      ...base,
      method: "POST",
      path: "/session/sess-1/prompt_async",
      search: "?directory=C%3A%2Frepo%2Fa",
    });

    const body = { parts: [{ type: "text", text: "hello" }] };

    expect(route.mode).toBe("project");
    expect(route.targetPath).toBe("/project/proj-1/session/sess-1/message");
    expect(route.targetSearch).toBe("");
    expect(route.rewriteJsonBody?.(body)).toBe(body);
  });

  it("maps abort, compact, revert, unrevert, share, and permission", () => {
    expect(resolveProjectSessionRoute({ ...base, method: "POST", path: "/session/sess-1/abort", search: "" }).targetPath).toBe(
      "/project/proj-1/session/sess-1/abort",
    );
    expect(resolveProjectSessionRoute({ ...base, method: "POST", path: "/session/sess-1/compact", search: "" }).targetPath).toBe(
      "/project/proj-1/session/sess-1/compact",
    );
    expect(resolveProjectSessionRoute({ ...base, method: "POST", path: "/session/sess-1/revert", search: "" }).targetPath).toBe(
      "/project/proj-1/session/sess-1/revert",
    );
    expect(resolveProjectSessionRoute({ ...base, method: "POST", path: "/session/sess-1/unrevert", search: "" }).targetPath).toBe(
      "/project/proj-1/session/sess-1/unrevert",
    );
    expect(resolveProjectSessionRoute({ ...base, method: "POST", path: "/session/sess-1/share", search: "" }).targetPath).toBe(
      "/project/proj-1/session/sess-1/share",
    );
    expect(resolveProjectSessionRoute({ ...base, method: "POST", path: "/session/sess-1/permission/perm-1", search: "" }).targetPath).toBe(
      "/project/proj-1/session/sess-1/permission/perm-1",
    );
  });

  it("keeps command, shell, summarize, status, and event as legacy directory routes", () => {
    expect(resolveProjectSessionRoute({ ...base, method: "POST", path: "/session/sess-1/command", search: "" })).toMatchObject({
      mode: "legacy",
      targetPath: "/session/sess-1/command",
      reason: "no-project-route",
    });
    expect(resolveProjectSessionRoute({ ...base, method: "POST", path: "/session/sess-1/shell", search: "" }).mode).toBe("legacy");
    expect(resolveProjectSessionRoute({ ...base, method: "POST", path: "/session/sess-1/summarize", search: "" }).mode).toBe("legacy");
    expect(resolveProjectSessionRoute({ ...base, method: "GET", path: "/session/status", search: "" }).mode).toBe("legacy");
    expect(resolveProjectSessionRoute({ ...base, method: "GET", path: "/event", search: "" }).mode).toBe("legacy");
  });
});
```

- [ ] **Step 2: Run the route tests and confirm failure**

Run:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/opencode-project-session-router.test.ts
```

Expected before implementation: FAIL because the module does not exist.

- [ ] **Step 3: Implement route adapter types**

Create `packages/orchestrator/src/opencode-project-session-router.ts`:

```ts
export type ProjectSessionRouteMode = "project" | "legacy";

export type ProjectSessionRoutePlan = {
  mode: ProjectSessionRouteMode;
  targetPath: string;
  targetSearch: string;
  reason?: "project-route" | "no-project-route" | "not-session-route";
  rewriteJsonBody?: (value: unknown) => unknown;
};

export type ProjectSessionRouteInput = {
  projectID: string;
  directory: string;
  method: string;
  path: string;
  search: string;
};

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function stripDirectoryQuery(search: string): string {
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  query.delete("directory");
  const next = query.toString();
  return next ? `?${next}` : "";
}

function withDirectory(value: unknown, directory: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { directory };
  }
  return {
    ...(value as Record<string, unknown>),
    directory,
  };
}

function legacy(input: ProjectSessionRouteInput, reason: ProjectSessionRoutePlan["reason"]): ProjectSessionRoutePlan {
  return {
    mode: "legacy",
    targetPath: input.path,
    targetSearch: input.search,
    reason,
  };
}

function project(targetPath: string, input: ProjectSessionRouteInput, rewriteJsonBody?: (value: unknown) => unknown): ProjectSessionRoutePlan {
  return {
    mode: "project",
    targetPath,
    targetSearch: stripDirectoryQuery(input.search),
    reason: "project-route",
    ...(rewriteJsonBody ? { rewriteJsonBody } : {}),
  };
}
```

- [ ] **Step 4: Implement route map**

Add this function to the same file:

```ts
export function resolveProjectSessionRoute(input: ProjectSessionRouteInput): ProjectSessionRoutePlan {
  const method = input.method.toUpperCase();
  const parts = input.path.split("/").filter(Boolean).map(decodeURIComponent);
  const projectPrefix = `/project/${encodeSegment(input.projectID)}`;

  if (parts[0] === "provider" || parts[0] === "config") {
    return legacy(input, "no-project-route");
  }

  if (method === "GET" && parts[0] === "project" && parts.length > 0) {
    return legacy(input, "not-session-route");
  }

  if (parts[0] !== "session") {
    return legacy(input, "not-session-route");
  }

  if (parts.length === 1) {
    if (method === "GET") {
      return project(`${projectPrefix}/session`, input);
    }
    if (method === "POST") {
      return project(`${projectPrefix}/session`, input, (value) => withDirectory(value, input.directory));
    }
    return legacy(input, "no-project-route");
  }

  if (parts[1] === "status") {
    return legacy(input, "no-project-route");
  }

  const sessionID = parts[1];
  const sessionPrefix = `${projectPrefix}/session/${encodeSegment(sessionID)}`;

  if (parts.length === 2) {
    if (method === "GET" || method === "DELETE") {
      return project(sessionPrefix, input);
    }
    return legacy(input, "no-project-route");
  }

  const action = parts[2];
  const singlePostActions = new Set(["init", "abort", "compact", "revert", "unrevert", "share"]);
  if (method === "POST" && singlePostActions.has(action) && parts.length === 3) {
    return project(`${sessionPrefix}/${encodeSegment(action)}`, input);
  }

  if (method === "DELETE" && action === "share" && parts.length === 3) {
    return project(`${sessionPrefix}/share`, input);
  }

  if (action === "message") {
    if (method === "GET" && parts.length === 3) {
      return project(`${sessionPrefix}/message`, input);
    }
    if (method === "GET" && parts.length === 4) {
      return project(`${sessionPrefix}/message/${encodeSegment(parts[3])}`, input);
    }
    if (method === "POST" && parts.length === 3) {
      return project(`${sessionPrefix}/message`, input, (value) => value);
    }
  }

  if (method === "POST" && action === "prompt_async" && parts.length === 3) {
    return project(`${sessionPrefix}/message`, input, (value) => value);
  }

  if (method === "POST" && action === "permission" && parts.length === 4) {
    return project(`${sessionPrefix}/permission/${encodeSegment(parts[3])}`, input);
  }

  if (method === "GET" && action === "find" && parts[3] === "file" && parts.length === 4) {
    return project(`${sessionPrefix}/find/file`, input);
  }

  if (method === "GET" && action === "file" && parts.length === 3) {
    return project(`${sessionPrefix}/file`, input);
  }

  if (method === "GET" && action === "file" && parts[3] === "status" && parts.length === 4) {
    return project(`${sessionPrefix}/file/status`, input);
  }

  return legacy(input, "no-project-route");
}
```

- [ ] **Step 5: Verify**

Run:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/opencode-project-session-router.test.ts
pnpm --filter veslo-orchestrator typecheck
```

Expected: PASS.

Commit:

```powershell
git add packages/orchestrator/src/opencode-project-session-router.ts packages/orchestrator/src/tests/opencode-project-session-router.test.ts
git commit -m "orchestrator: map workspace opencode routes to project sessions"
```

---

### Task 4: Wire Project Adapter Into Orchestrator Proxy

**Files:**

- Modify: `packages/orchestrator/src/cli.ts`
- Modify: `packages/orchestrator/src/opencode-proxy-target.ts`
- Modify: `packages/orchestrator/src/tests/opencode-proxy-target.test.ts`

- [ ] **Step 1: Add proxy-level tests for route selection**

Extend `packages/orchestrator/src/tests/opencode-proxy-target.test.ts` with a project-mode expectation:

```ts
it("keeps project sessions disabled unless topology enables them", async () => {
  const target = await resolveOpencodeProxyTarget({
    topology: "shared-unsandboxed",
    method: "POST",
    workspaceId: "ws-a",
    workspacePath: "C:/repo/a",
    pooledEngine: pooled,
    sharedEngine: shared,
    projectSessions: false,
  });

  expect(target.projectSessions).toBe(false);
});

it("marks shared proxy targets as project-session capable when enabled", async () => {
  const target = await resolveOpencodeProxyTarget({
    topology: "shared-unsandboxed",
    method: "POST",
    workspaceId: "ws-a",
    workspacePath: "C:/repo/a",
    pooledEngine: pooled,
    sharedEngine: shared,
    projectSessions: true,
  });

  expect(target.engineKind).toBe("shared");
  expect(target.projectSessions).toBe(true);
});
```

- [ ] **Step 2: Add target metadata**

In `packages/orchestrator/src/opencode-proxy-target.ts`, add:

```ts
projectSessions: boolean;
```

to `OpenCodeProxyTarget`.

Add input:

```ts
projectSessions?: boolean;
```

Set it in returns:

```ts
projectSessions: input.topology === "shared-unsandboxed" && Boolean(input.projectSessions),
```

For pooled returns, always set:

```ts
projectSessions: false,
```

- [ ] **Step 3: Instantiate registry only in project mode**

In `packages/orchestrator/src/cli.ts`, import:

```ts
import { OpenCodeProjectRegistry } from "./opencode-project-registry.js";
import { resolveProjectSessionRoute } from "./opencode-project-session-router.js";
```

After `sharedOpenCodeEngine` creation, add:

```ts
let openCodeProjectRegistry: OpenCodeProjectRegistry | null = null;
```

Do not create the registry until an engine base URL exists. It must be tied to the running shared engine base URL.

- [ ] **Step 4: Pass project flag into target resolution**

Where `resolveOpencodeProxyTarget` is called, pass:

```ts
projectSessions: engineTopology.projectSessions,
```

- [ ] **Step 5: Resolve project route before `proxyToEngine`**

In the `/workspace/:id/opencode/*` handler, after `engineDirectory` is computed and before `injectHeaders`, add:

```ts
let upstreamPath = restPath;
let upstreamSearch = targetSearch;
let projectRouteBodyRewrite: ((value: unknown) => unknown) | undefined;
let upstreamProjectID: string | null = null;

if (proxyTarget.projectSessions) {
  if (!openCodeProjectRegistry || openCodeProjectRegistryBaseUrl !== engine.baseUrl) {
    openCodeProjectRegistry = new OpenCodeProjectRegistry({
      baseUrl: engine.baseUrl,
      headers: authHeaders,
    });
    openCodeProjectRegistryBaseUrl = engine.baseUrl;
  }

  const project = await openCodeProjectRegistry.ensureProjectForDirectory(engineDirectory);
  upstreamProjectID = project.projectID;
  const route = resolveProjectSessionRoute({
    projectID: project.projectID,
    directory: engineDirectory,
    method: proxyMethod,
    path: restPath,
    search: targetSearch,
  });
  upstreamPath = route.targetPath;
  upstreamSearch = route.targetSearch;
  projectRouteBodyRewrite = route.rewriteJsonBody;
}
```

Declare the base URL tracker near the registry:

```ts
let openCodeProjectRegistryBaseUrl: string | null = null;
```

- [ ] **Step 6: Use adapted upstream path/search**

Change tracing and proxy call inputs from `restPath`/`targetSearch` to `upstreamPath`/`upstreamSearch`.

In `finishUpstreamTrace`, include:

```ts
projectSessions: proxyTarget.projectSessions,
upstreamProjectID,
targetPath: upstreamPath,
targetSearch: upstreamSearch,
```

In `proxyToEngine`, pass:

```ts
targetPath: upstreamPath,
targetSearch: upstreamSearch,
rewriteJsonBody: projectRouteBodyRewrite,
```

Because project mode is only valid in `shared-unsandboxed`, do not compose this body rewrite with WSL path rewriting. If `rewriteEnginePaths` is true while `proxyTarget.projectSessions` is true, throw:

```ts
throw new Error("OpenCode project sessions cannot run with WSL path rewriting");
```

- [ ] **Step 7: Update health payload**

In `/health`, add:

```ts
opencodeProjectSessions: {
  enabled: engineTopology.projectSessions,
  registry: openCodeProjectRegistry?.snapshot() ?? null,
},
```

- [ ] **Step 8: Verify**

Run:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/opencode-proxy-target.test.ts src/tests/opencode-project-registry.test.ts src/tests/opencode-project-session-router.test.ts
pnpm --filter veslo-orchestrator typecheck
```

Expected: PASS.

Commit:

```powershell
git add packages/orchestrator/src/cli.ts packages/orchestrator/src/opencode-proxy-target.ts packages/orchestrator/src/tests/opencode-proxy-target.test.ts
git commit -m "orchestrator: route shared opencode through project sessions"
```

---

### Task 5: Route Run Activity Probe Through The Same Adapter

**Files:**

- Modify: `packages/orchestrator/src/run-activity-probe.ts`
- Create or modify: `packages/orchestrator/src/tests/run-activity-probe.test.ts`

- [ ] **Step 1: Add failing test for project message path**

In `packages/orchestrator/src/tests/run-activity-probe.test.ts`, add a test that configures project routing and expects message reads to use the project path:

```ts
it("uses project-scoped message path when project sessions are enabled", async () => {
  const requested: string[] = [];
  const probe = createRunActivityProbe({
    getEngine: () => ({ baseUrl: "http://engine" } as never),
    buildEngineRequest: (engine, path) => {
      requested.push(path);
      return new Request(`${engine.baseUrl}${path}`);
    },
    resolveProjectRoute: async ({ path, search }) => ({
      targetPath: "/project/proj-1/session/sess-a/message",
      targetSearch: search,
      projectID: "proj-1",
    }),
  });

  await probe.poll({
    workspaceId: "ws-a",
    conversationId: "conv-a",
    engineSessionId: "sess-a",
    directory: "C:/repo/a",
  });

  expect(requested[0]).toBe("/project/proj-1/session/sess-a/message?limit=80");
});
```

- [ ] **Step 2: Add injectable route resolver**

In `packages/orchestrator/src/run-activity-probe.ts`, extend the factory input:

```ts
resolveProjectRoute?: (input: {
  workspaceId: string;
  directory: string;
  method: string;
  path: string;
  search: string;
}) => Promise<{ targetPath: string; targetSearch: string; projectID: string | null }>;
```

When building the message request, use:

```ts
const legacyPath = `/session/${encodeURIComponent(record.engineSessionId)}/message`;
const legacySearch = "?limit=80";
const routed = options.resolveProjectRoute
  ? await options.resolveProjectRoute({
      workspaceId: record.workspaceId,
      directory: record.directory,
      method: "GET",
      path: legacyPath,
      search: legacySearch,
    })
  : null;
const path = routed ? `${routed.targetPath}${routed.targetSearch}` : `${legacyPath}${legacySearch}`;
```

- [ ] **Step 3: Wire orchestrator resolver**

In `packages/orchestrator/src/cli.ts`, when creating `createRunActivityProbe`, pass `resolveProjectRoute` only when `engineTopology.projectSessions` is true:

```ts
resolveProjectRoute: engineTopology.projectSessions
  ? async ({ directory, method, path, search }) => {
      const engine = sharedOpenCodeEngine?.getRunning();
      if (!engine) return { targetPath: path, targetSearch: search, projectID: null };
      if (!openCodeProjectRegistry || openCodeProjectRegistryBaseUrl !== engine.baseUrl) {
        openCodeProjectRegistry = new OpenCodeProjectRegistry({
          baseUrl: engine.baseUrl,
          headers: authHeaders,
        });
        openCodeProjectRegistryBaseUrl = engine.baseUrl;
      }
      const project = await openCodeProjectRegistry.ensureProjectForDirectory(directory);
      const route = resolveProjectSessionRoute({
        projectID: project.projectID,
        directory,
        method,
        path,
        search,
      });
      return {
        targetPath: route.targetPath,
        targetSearch: route.targetSearch,
        projectID: project.projectID,
      };
    }
  : undefined,
```

- [ ] **Step 4: Verify**

Run:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/run-activity-probe.test.ts
pnpm --filter veslo-orchestrator typecheck
```

Expected: PASS.

Commit:

```powershell
git add packages/orchestrator/src/run-activity-probe.ts packages/orchestrator/src/tests/run-activity-probe.test.ts packages/orchestrator/src/cli.ts
git commit -m "orchestrator: route activity probe through opencode projects"
```

---

### Task 6: Preserve Server And App Public Contracts

**Files:**

- Modify: `packages/server/src/tests/server-conversations.test.ts`
- Modify: `packages/server/src/tests/server-stale-active-run.integration.test.ts`
- Inspect only: `packages/server/src/server.ts`
- Inspect only: `packages/app/src/app/lib/opencode.ts`
- Inspect only: `packages/opencode-router/src/bridge.ts`

- [ ] **Step 1: Add server contract assertion**

In `packages/server/src/tests/server-conversations.test.ts`, keep the expected server-to-orchestrator path as the legacy workspace-scoped URL:

```ts
expect(receivedRunPaths[0]).toBe(
  `/session/sess-created/prompt_async?directory=${encodeURIComponent(workspaceRoot)}`,
);
```

For orchestrator-backed tests, assert the outer path remains:

```ts
expect(entry.pathname).toBe("/workspace/ws_1/opencode/session/sess-created/prompt_async");
```

This proves server code does not bypass Veslo workspace identity by calling `/project/:projectID` directly.

- [ ] **Step 2: Add stale-active run assertion**

In `packages/server/src/tests/server-stale-active-run.integration.test.ts`, keep both regex checks:

```ts
const messageMatch = /^\/workspace\/ws_1\/opencode\/session\/([^/]+)\/message$/.exec(url.pathname);
const promptMatch = /^\/workspace\/ws_1\/opencode\/session\/([^/]+)\/prompt_async$/.exec(url.pathname);
```

Add:

```ts
expect(request.url).not.toContain("/project/");
```

inside the fake server request collector.

- [ ] **Step 3: Inspect app and router clients**

Confirm these files still build clients against the workspace-scoped base URL:

```text
packages/app/src/app/lib/opencode.ts
packages/opencode-router/src/bridge.ts
```

Expected invariant:

```ts
createOpencodeClient({
  baseUrl,
  directory,
  headers,
  fetch: wrappedFetch,
});
```

Do not add `projectID` to the app SDK client in this task.

- [ ] **Step 4: Verify**

Run:

```powershell
pnpm --filter veslo-server test -- server-conversations
pnpm --filter veslo-server test -- server-stale-active-run.integration
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-code-router typecheck
```

Expected: PASS.

Commit:

```powershell
git add packages/server/src/tests/server-conversations.test.ts packages/server/src/tests/server-stale-active-run.integration.test.ts
git commit -m "test: preserve veslo workspace opencode contract"
```

---

### Task 7: Add Real OpenCode Project Session Smoke

**Files:**

- Create: `packages/orchestrator/scripts/opencode-project-session-smoke.mjs`
- Modify: `packages/orchestrator/package.json`

- [ ] **Step 1: Create smoke script**

Create `packages/orchestrator/scripts/opencode-project-session-smoke.mjs`:

```js
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import net from "node:net";

const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
const sidecar =
  process.platform === "win32"
    ? resolve(repoRoot, "packages/desktop/src-tauri/sidecars/veslo-code.exe")
    : resolve(repoRoot, "packages/desktop/src-tauri/sidecars/veslo-code");
const username = "veslo-project-smoke";
const password = "veslo-project-smoke-token";
const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolvePort(port));
    });
    server.on("error", reject);
  });
}

async function waitForHealth(baseUrl) {
  const deadline = Date.now() + 60_000;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        headers: { authorization: auth },
      });
      if (response.ok) return;
      lastError = `${response.status} ${await response.text()}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error(`OpenCode health failed: ${lastError}`);
}

async function requestJson(method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: auth,
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 404 || response.status === 405) {
    throw new Error(`${method} ${url} returned ${response.status}`);
  }
  const text = await response.text();
  return {
    status: response.status,
    ok: response.ok,
    body: text ? JSON.parse(text) : null,
  };
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} missing`);
  }
  return value;
}

async function main() {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const workspaceA = await mkdtemp(join(tmpdir(), "veslo-project-a-"));
  const workspaceB = await mkdtemp(join(tmpdir(), "veslo-project-b-"));
  const configDir = await mkdtemp(join(tmpdir(), "veslo-project-config-"));
  await writeFile(join(workspaceA, "README.md"), "workspace a\n");
  await writeFile(join(workspaceB, "README.md"), "workspace b\n");

  const child = spawn(sidecar, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: workspaceA,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: configDir,
      OPENCODE_USERNAME: username,
      OPENCODE_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForHealth(baseUrl);

    const initA = await requestJson("POST", `${baseUrl}/project/init?directory=${encodeURIComponent(workspaceA)}`, undefined, {
      "x-opencode-directory": workspaceA,
    });
    const projectA = requireString(initA.body?.id ?? initA.body?.projectID, "project A id");

    const initB = await requestJson("POST", `${baseUrl}/project/init?directory=${encodeURIComponent(workspaceB)}`, undefined, {
      "x-opencode-directory": workspaceB,
    });
    const projectB = requireString(initB.body?.id ?? initB.body?.projectID, "project B id");

    if (projectA === projectB) {
      throw new Error(`project IDs must differ for distinct workspaces: ${projectA}`);
    }

    const sessionA = await requestJson("POST", `${baseUrl}/project/${encodeURIComponent(projectA)}/session`, {
      directory: workspaceA,
    });
    const sessionAID = requireString(sessionA.body?.id, "session A id");

    const sessionB = await requestJson("POST", `${baseUrl}/project/${encodeURIComponent(projectB)}/session`, {
      directory: workspaceB,
    });
    const sessionBID = requireString(sessionB.body?.id, "session B id");

    await requestJson("GET", `${baseUrl}/project/${encodeURIComponent(projectA)}/session/${encodeURIComponent(sessionAID)}/message`, undefined);
    await requestJson("GET", `${baseUrl}/project/${encodeURIComponent(projectB)}/session/${encodeURIComponent(sessionBID)}/message`, undefined);

    const promptCheck = await requestJson(
      "POST",
      `${baseUrl}/project/${encodeURIComponent(projectA)}/session/${encodeURIComponent(sessionAID)}/message`,
      { parts: [{ type: "text", text: "smoke" }] },
    );
    if (promptCheck.status === 404 || promptCheck.status === 405) {
      throw new Error("project message route is not available");
    }

    console.log("OpenCode project session smoke passed");
  } finally {
    child.kill("SIGTERM");
    await rm(workspaceA, { recursive: true, force: true });
    await rm(workspaceB, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    if (process.exitCode && stderr) console.error(stderr);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

- [ ] **Step 2: Add package script**

In `packages/orchestrator/package.json`, add:

```json
"test:opencode-project-session": "node scripts/opencode-project-session-smoke.mjs"
```

- [ ] **Step 3: Run smoke**

Run:

```powershell
pnpm --filter @neatech/veslo prepare:sidecar
pnpm --filter veslo-orchestrator test:opencode-project-session
```

Expected: PASS and output contains:

```text
OpenCode project session smoke passed
```

If the `POST /project/:projectID/session/:sessionID/message` call returns a provider/model validation error with HTTP 400, capture the exact body and keep the route adapter enabled because the route exists. If it returns 404 or 405, stop this implementation and do not enable `VESLO_OPENCODE_PROJECT_SESSIONS` in launcher scripts.

- [ ] **Step 4: Verify**

Run:

```powershell
pnpm --filter veslo-orchestrator typecheck
```

Expected: PASS.

Commit:

```powershell
git add packages/orchestrator/scripts/opencode-project-session-smoke.mjs packages/orchestrator/package.json
git commit -m "test: smoke opencode project session api"
```

---

### Task 8: Document Flags, Warnings, And Rollback

**Files:**

- Create: `docs/dev/opencode-project-session-model.md`
- Modify: `docs/dev/opencode-shared-non-sandbox-runtime.md`

- [ ] **Step 1: Create project-session docs**

Create `docs/dev/opencode-project-session-model.md`:

```md
# OpenCode Project Session Model

Veslo can route one non-sandbox shared OpenCode 1.17.4 engine through OpenCode's project/session API.

This mode is disabled by default. It requires all three flags:

```powershell
$env:VESLO_DISABLE_SANDBOX = "1"
$env:VESLO_SHARED_OPENCODE_ENGINE = "1"
$env:VESLO_OPENCODE_PROJECT_SESSIONS = "1"
```

## Why Non-Sandbox Only

OpenCode project/session routing is useful when one OpenCode process serves multiple Veslo workspaces. Sandboxed Veslo workspaces intentionally run isolated engines, so they keep the existing per-workspace `/session` plus directory routing.

The orchestrator refuses `VESLO_OPENCODE_PROJECT_SESSIONS=1` unless the topology is `shared-unsandboxed`.

## Request Routing

Veslo public URLs stay workspace-scoped:

```text
/workspace/:workspaceID/opencode/session
/workspace/:workspaceID/opencode/session/:sessionID/message
/workspace/:workspaceID/opencode/session/:sessionID/prompt_async
```

In project-session mode, the orchestrator resolves the OpenCode project for the Veslo workspace directory and sends supported upstream calls to:

```text
/project/:projectID/session
/project/:projectID/session/:sessionID/message
```

Veslo workspace IDs remain the product identity. OpenCode project IDs are upstream routing metadata cached by the orchestrator.

## Routes That Stay Directory-Scoped

OpenCode 1.17.4 does not define project-scoped replacements for:

```text
/session/status
/session/:sessionID/command
/session/:sessionID/shell
/session/:sessionID/summarize
/event
```

Those routes keep the existing directory-scoped behavior.

## Verification

Run:

```powershell
pnpm --filter @neatech/veslo prepare:sidecar
pnpm --filter veslo-orchestrator test:opencode-project-session
pnpm --filter veslo-orchestrator typecheck
```

Run the app in shared project-session mode, open two local workspaces, send one prompt in each workspace, and confirm:

- `/health` reports `engineTopology: "shared-unsandboxed"`.
- `/health` reports `opencodeProjectSessions.enabled: true`.
- Only one OpenCode process is running.
- Requests for workspace A resolve to project A.
- Requests for workspace B resolve to project B.
- Session/message data does not cross between workspaces.

## Rollback

Remove only this env var and restart:

```powershell
Remove-Item Env:\VESLO_OPENCODE_PROJECT_SESSIONS
```

The runtime remains in shared non-sandbox compatibility mode if `VESLO_SHARED_OPENCODE_ENGINE=1` is still set. Remove `VESLO_SHARED_OPENCODE_ENGINE` as well to return to pooled per-workspace engines.
```

- [ ] **Step 2: Link from shared runtime docs**

In `docs/dev/opencode-shared-non-sandbox-runtime.md`, add:

```md
## Project Session Routing

For OpenCode 1.17.4 project/session routing, see `docs/dev/opencode-project-session-model.md`.

The project/session adapter requires:

```powershell
$env:VESLO_DISABLE_SANDBOX = "1"
$env:VESLO_SHARED_OPENCODE_ENGINE = "1"
$env:VESLO_OPENCODE_PROJECT_SESSIONS = "1"
```
```

- [ ] **Step 3: Verify docs against code**

Run:

```powershell
rg "VESLO_OPENCODE_PROJECT_SESSIONS|opencodeProjectSessions|opencode-project-session" packages docs
```

Expected: the flag appears in orchestrator code, tests, smoke script, and docs.

Commit:

```powershell
git add docs/dev/opencode-project-session-model.md docs/dev/opencode-shared-non-sandbox-runtime.md
git commit -m "docs: document opencode project session routing"
```

---

### Task 9: End-To-End Verification Matrix

**Files:**

- Modify: `docs/dev/opencode-project-session-model.md`

- [ ] **Step 1: Static and unit checks**

Run:

```powershell
pnpm --filter veslo-orchestrator exec bun test src/tests/engine-topology.test.ts src/tests/opencode-project-registry.test.ts src/tests/opencode-project-session-router.test.ts src/tests/opencode-proxy-target.test.ts src/tests/run-activity-probe.test.ts
pnpm --filter veslo-orchestrator typecheck
pnpm --filter veslo-server test -- server-conversations
pnpm --filter veslo-server test -- server-stale-active-run.integration
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-code-router typecheck
```

Expected: PASS.

- [ ] **Step 2: Sidecar and project API smoke**

Run:

```powershell
pnpm --filter @neatech/veslo prepare:sidecar
packages\desktop\src-tauri\sidecars\veslo-code.exe --version
pnpm --filter veslo-orchestrator test:opencode-project-session
```

Expected:

```text
1.17.4
OpenCode project session smoke passed
```

- [ ] **Step 3: Default pooled runtime smoke**

Start the runtime with no shared env:

```powershell
Remove-Item Env:\VESLO_DISABLE_SANDBOX -ErrorAction SilentlyContinue
Remove-Item Env:\VESLO_SHARED_OPENCODE_ENGINE -ErrorAction SilentlyContinue
Remove-Item Env:\VESLO_OPENCODE_PROJECT_SESSIONS -ErrorAction SilentlyContinue
```

Open two local workspaces and confirm:

```text
/health engineTopology = pooled-per-workspace
/health opencodeProjectSessions.enabled = false
Workspace A and workspace B do not share an OpenCode process.
```

- [ ] **Step 4: Shared compatibility runtime smoke**

Start the runtime with:

```powershell
$env:VESLO_DISABLE_SANDBOX = "1"
$env:VESLO_SHARED_OPENCODE_ENGINE = "1"
Remove-Item Env:\VESLO_OPENCODE_PROJECT_SESSIONS -ErrorAction SilentlyContinue
```

Open two local workspaces and confirm:

```text
/health engineTopology = shared-unsandboxed
/health opencodeProjectSessions.enabled = false
One OpenCode process serves both workspaces.
Upstream trace targetPath still starts with /session.
```

- [ ] **Step 5: Shared project-session runtime smoke**

Start the runtime with:

```powershell
$env:VESLO_DISABLE_SANDBOX = "1"
$env:VESLO_SHARED_OPENCODE_ENGINE = "1"
$env:VESLO_OPENCODE_PROJECT_SESSIONS = "1"
```

Open two local workspaces, send one prompt in each, and confirm:

```text
/health engineTopology = shared-unsandboxed
/health opencodeProjectSessions.enabled = true
One OpenCode process serves both workspaces.
Workspace A trace includes targetPath /project/<projectA>/session.
Workspace B trace includes targetPath /project/<projectB>/session.
projectA != projectB.
Workspace A transcript does not include workspace B prompt.
Workspace B transcript does not include workspace A prompt.
```

- [ ] **Step 6: Invalid config smoke**

Run:

```powershell
$env:VESLO_OPENCODE_PROJECT_SESSIONS = "1"
Remove-Item Env:\VESLO_SHARED_OPENCODE_ENGINE -ErrorAction SilentlyContinue
```

Expected: startup fails with:

```text
VESLO_OPENCODE_PROJECT_SESSIONS=1 requires VESLO_SHARED_OPENCODE_ENGINE=1
```

Run WSL sandbox configuration with:

```powershell
$env:VESLO_DISABLE_SANDBOX = "1"
$env:VESLO_SHARED_OPENCODE_ENGINE = "1"
$env:VESLO_OPENCODE_PROJECT_SESSIONS = "1"
$env:VESLO_SANDBOX_BACKEND = "windows-wsl2"
```

Expected: startup fails before spawning a shared engine with:

```text
OpenCode project session routing is only supported in shared-unsandboxed topology
```

- [ ] **Step 7: Record verified commands**

Append this section to `docs/dev/opencode-project-session-model.md` with only commands that passed:

```md
## Verified On 2026-06-13

Commands:

- `pnpm --filter veslo-orchestrator exec bun test src/tests/engine-topology.test.ts src/tests/opencode-project-registry.test.ts src/tests/opencode-project-session-router.test.ts src/tests/opencode-proxy-target.test.ts src/tests/run-activity-probe.test.ts`
- `pnpm --filter veslo-orchestrator typecheck`
- `pnpm --filter veslo-server test -- server-conversations`
- `pnpm --filter veslo-server test -- server-stale-active-run.integration`
- `pnpm --filter @neatech/veslo-ui typecheck`
- `pnpm --filter veslo-code-router typecheck`
- `pnpm --filter @neatech/veslo prepare:sidecar`
- `packages\desktop\src-tauri\sidecars\veslo-code.exe --version`
- `pnpm --filter veslo-orchestrator test:opencode-project-session`
```

- [ ] **Step 8: Diff cleanup**

Run:

```powershell
git diff --stat
git diff --check
git status --short --untracked-files=normal
```

Expected: no whitespace errors. Diff is limited to orchestrator adapter, tests, smoke, and docs.

Commit:

```powershell
git add docs/dev/opencode-project-session-model.md
git commit -m "docs: record opencode project session verification"
```

---

## Rollback Plan

Disable only project/session routing:

```powershell
Remove-Item Env:\VESLO_OPENCODE_PROJECT_SESSIONS -ErrorAction SilentlyContinue
```

The shared non-sandbox engine remains available through the compatibility path.

Disable the shared engine completely:

```powershell
Remove-Item Env:\VESLO_SHARED_OPENCODE_ENGINE -ErrorAction SilentlyContinue
Remove-Item Env:\VESLO_DISABLE_SANDBOX -ErrorAction SilentlyContinue
```

The orchestrator returns to pooled per-workspace engines. Veslo workspace IDs, server conversation IDs, and binding-store keys are not migrated by this plan, so rollback does not require data migration.

## Self-Review

Spec coverage:

- Non-sandbox shared project/session routing is covered by Tasks 1, 2, 3, 4, 5, and 9.
- Sandbox and WSL sandbox separation is covered by Task 1 and the runtime matrix.
- Server legacy call sites remain stable and are tested in Task 6.
- App and router SDK client behavior remains stable and is inspected in Task 6.
- Installer/sidecar distribution is covered by Task 7 through `prepare:sidecar` plus the real sidecar smoke.
- Documentation and rollback are covered by Task 8 and the rollback section.

Placeholder scan:

- The plan names exact files, flags, commands, expected outputs, and route mappings.
- Unsupported OpenCode routes are listed explicitly and stay on the legacy directory path.
- The adapter is gated by `VESLO_OPENCODE_PROJECT_SESSIONS=1` and is rejected outside `shared-unsandboxed`.

Type consistency:

- `projectSessions` is a boolean on `EngineTopology` and `OpenCodeProxyTarget`.
- `OpenCodeProjectRegistry.ensureProjectForDirectory()` returns `projectID`, `directory`, `source`, and `project`.
- `resolveProjectSessionRoute()` returns `targetPath`, `targetSearch`, `mode`, and optional `rewriteJsonBody`.
