import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { WorkspaceInfo } from "./types.js";

const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Mock OpenCode server: every request echoes back what it received so we can
 * verify Veslo's routing/forwarding is correct.
 */
function startMockOpencode() {
  const responses: Array<{
    pathname: string;
    directory: string | null;
    auth: string | null;
    method: string;
    acceptEncoding: string | null;
  }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request: Request) {
      const url = new URL(request.url);
      const directory = request.headers.get("x-opencode-directory");
      const auth = request.headers.get("authorization");
      responses.push({
        pathname: url.pathname,
        directory,
        auth,
        method: request.method,
        acceptEncoding: request.headers.get("accept-encoding"),
      });
      return new Response(
        JSON.stringify({
          seenPath: url.pathname,
          seenDirectory: directory,
          seenAuth: auth,
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  runningServers.push(server as unknown as { stop?: (closeActiveConnections?: boolean) => void });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    responses,
  };
}

function buildWorkspace(id: string, path: string, baseUrl: string): WorkspaceInfo {
  return {
    id,
    name: `Workspace ${id}`,
    path,
    workspaceType: "local",
    baseUrl,
    opencodeUsername: "veslo",
    opencodePassword: `pw-${id}`,
  };
}

async function startVesloFixture(workspaces: WorkspaceInfo[]) {
  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces,
    authorizedRoots: workspaces.map((w) => w.path),
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 200,
      batchMaxBytes: 256 * 1024,
      spoolMaxBytes: 100 * 1024 * 1024,
      flushIntervalMs: 5000,
    },
  });
  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });
  return { server };
}

async function makeTwoWorkspaces() {
  const wsA = await mkdtemp(join(tmpdir(), "veslo-ws-A-"));
  const wsB = await mkdtemp(join(tmpdir(), "veslo-ws-B-"));
  tempDirs.push(wsA, wsB);
  const mock = startMockOpencode();
  const workspaces = [
    buildWorkspace("ws_alpha", wsA, mock.baseUrl),
    buildWorkspace("ws_beta", wsB, mock.baseUrl),
  ];
  const { server } = await startVesloFixture(workspaces);
  return { server, mock, wsA, wsB };
}

test("canonical /workspace/:id/opencode/* routes request with directory from workspace A", async () => {
  const { server, mock, wsA } = await makeTwoWorkspaces();

  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_alpha/opencode/health`,
    { headers: { Authorization: "Bearer client-token" } },
  );

  expect(response.status).toBe(200);
  const payload = (await response.json()) as { seenDirectory: string };
  expect(payload.seenDirectory).toBe(wsA);
  expect(mock.responses[0]!.directory).toBe(wsA);
});

test("OpenCode health proxy forces identity encoding for upstream fetch", async () => {
  const { server, mock } = await makeTwoWorkspaces();

  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_alpha/opencode/global/health`,
    {
      headers: {
        Authorization: "Bearer client-token",
        "Accept-Encoding": "gzip, deflate, br",
      },
    },
  );

  expect(response.status).toBe(200);
  expect(mock.responses[0]!.acceptEncoding).toBe("identity");
});

test("workspace-scoped OpenCode base URL preserves orchestrator mount and retargets workspace id", async () => {
  const wsA = await mkdtemp(join(tmpdir(), "veslo-ws-A-"));
  tempDirs.push(wsA);
  const mock = startMockOpencode();
  const workspaces = [
    buildWorkspace("ws_alpha", wsA, `${mock.baseUrl}/workspace/ws_stale/opencode`),
  ];
  const { server } = await startVesloFixture(workspaces);

  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_alpha/opencode/global/health`,
    { headers: { Authorization: "Bearer client-token" } },
  );

  expect(response.status).toBe(200);
  expect(mock.responses[0]!.pathname).toBe("/workspace/ws_alpha/opencode/global/health");
});

test("canonical /workspace/:id/opencode/* routes request with directory from workspace B", async () => {
  const { server, mock, wsB } = await makeTwoWorkspaces();

  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_beta/opencode/health`,
    { headers: { Authorization: "Bearer client-token" } },
  );

  expect(response.status).toBe(200);
  const payload = (await response.json()) as { seenDirectory: string };
  expect(payload.seenDirectory).toBe(wsB);
  expect(mock.responses[0]!.directory).toBe(wsB);
});

test("short /w/:id/opencode/* alias produces the same routing as canonical form", async () => {
  const { server, mock, wsA } = await makeTwoWorkspaces();

  const canonical = await (await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_alpha/opencode/session/list`,
    { headers: { Authorization: "Bearer client-token" } },
  )).json() as { seenPath: string; seenDirectory: string };
  const aliased = await (await fetch(
    `http://127.0.0.1:${server.port}/w/ws_alpha/opencode/session/list`,
    { headers: { Authorization: "Bearer client-token" } },
  )).json() as { seenPath: string; seenDirectory: string };

  expect(canonical.seenPath).toBe(aliased.seenPath);
  expect(canonical.seenDirectory).toBe(aliased.seenDirectory);
  expect(canonical.seenDirectory).toBe(wsA);
});

test("parallel requests to different workspaces route correctly without race conditions", async () => {
  const { server, mock, wsA, wsB } = await makeTwoWorkspaces();

  // Fire 10 parallel requests alternating between A and B
  const requests: Promise<{ seenDirectory: string; expected: string }>[] = [];
  for (let i = 0; i < 10; i += 1) {
    const id = i % 2 === 0 ? "ws_alpha" : "ws_beta";
    const expected = i % 2 === 0 ? wsA : wsB;
    requests.push(
      fetch(`http://127.0.0.1:${server.port}/workspace/${id}/opencode/health`, {
        headers: { Authorization: "Bearer client-token" },
      })
        .then((r) => r.json() as Promise<{ seenDirectory: string }>)
        .then((p) => ({ seenDirectory: p.seenDirectory, expected })),
    );
  }
  const results = await Promise.all(requests);

  for (const { seenDirectory, expected } of results) {
    expect(seenDirectory).toBe(expected);
  }
  expect(mock.responses).toHaveLength(10);
});

test("?directory query override takes precedence over workspace path", async () => {
  const { server, mock } = await makeTwoWorkspaces();
  const customDir = "/custom/override/path";

  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_alpha/opencode/health?directory=${encodeURIComponent(customDir)}`,
    { headers: { Authorization: "Bearer client-token" } },
  );

  const payload = (await response.json()) as { seenDirectory: string };
  expect(payload.seenDirectory).toBe(customDir);
});

test("workspace A's Basic auth header is forwarded with its workspace-scoped request", async () => {
  const { server, mock } = await makeTwoWorkspaces();

  await fetch(`http://127.0.0.1:${server.port}/workspace/ws_alpha/opencode/health`, {
    headers: { Authorization: "Bearer client-token" },
  });
  const aAuth = mock.responses[0]!.auth;
  expect(aAuth?.startsWith("Basic ")).toBe(true);

  await fetch(`http://127.0.0.1:${server.port}/workspace/ws_beta/opencode/health`, {
    headers: { Authorization: "Bearer client-token" },
  });
  const bAuth = mock.responses[1]!.auth;
  expect(bAuth?.startsWith("Basic ")).toBe(true);

  // Different passwords per workspace → different Basic auth values
  expect(aAuth).not.toBe(bAuth);
});

test("POST body is forwarded with correct directory header", async () => {
  const { server, mock, wsB } = await makeTwoWorkspaces();

  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_beta/opencode/session/create`,
    {
      method: "POST",
      headers: { Authorization: "Bearer client-token", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "test" }),
    },
  );

  expect(response.status).toBe(200);
  const payload = (await response.json()) as { seenDirectory: string };
  expect(payload.seenDirectory).toBe(wsB);
  expect(mock.responses[0]!.method).toBe("POST");
});

test("404 path on opencode still routes through with correct directory (exercises error pass-through)", async () => {
  const { server, mock, wsA } = await makeTwoWorkspaces();

  // The mock OpenCode returns 200 for anything; this test verifies the routing
  // works even on uncommon paths.
  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_alpha/opencode/unknown/deeply/nested`,
    { headers: { Authorization: "Bearer client-token" } },
  );
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { seenDirectory: string };
  expect(payload.seenDirectory).toBe(wsA);
});

test("unknown workspace id returns 404", async () => {
  const { server } = await makeTwoWorkspaces();

  const response = await fetch(
    `http://127.0.0.1:${server.port}/workspace/ws_nonexistent/opencode/health`,
    { headers: { Authorization: "Bearer client-token" } },
  );

  expect(response.status).toBe(404);
});
