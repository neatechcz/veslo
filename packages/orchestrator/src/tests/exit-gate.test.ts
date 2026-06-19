import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { EnginePool } from "../engine-pool.js";
import { proxyToEngine } from "../router-proxy.js";

/**
 * VSLO-171 fáze 2 F2Ú8 — exit gate test.
 *
 * Václavův scénář prokazuje původní cíl celé fáze 2: paralelní práce
 * napříč workspaces. Pool, routing, lifecycle automation jsou pokryty
 * unit testy individuálně; tento test ověřuje celý HTTP stack ve společné
 * session.
 *
 * In-process pattern: orchestrator dispatcher jako Node http surrogate,
 * shared echo server místo real OpenCode binárky. EnginePool se chová
 * stejně jako v produkci (real ChildProcess pro pid tracking, real
 * proxyToEngine pro request/response).
 */

// === Test infrastructure (copy from router-proxy.test.ts) ===

function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopChild(child: ChildProcess, timeoutMs = 1500): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
  if (exited) return;
  try {
    child.kill("SIGKILL");
  } catch {
    return;
  }
  await Promise.race([
    once(child, "exit").then(() => true),
    new Promise((resolve) => setTimeout(resolve, timeoutMs, false)),
  ]);
}

type EchoServer = {
  baseUrl: string;
  close: () => Promise<void>;
  setHandler: (handler: (req: IncomingMessage, res: ServerResponse) => void) => void;
};

async function makeEchoServer(): Promise<EchoServer> {
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  const server = createServer((req, res) => {
    res.setHeader("connection", "close");
    if (handler) {
      handler(req, res);
      return;
    }
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ method: req.method, path: req.url }));
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      try {
        server.close();
      } catch {
        // see makeEchoServer comment in router-proxy.test.ts: server.close
        // can hang under Bun's node:http compat when keep-alive sockets are
        // still in TIME_WAIT. unref + close fire-and-forget is sufficient.
      }
    },
    setHandler: (h) => {
      handler = h;
    },
  };
}

type WorkspaceRecord = { id: string; path: string; type: "local" | "remote" };

type Orchestrator = {
  baseUrl: string;
  pool: EnginePool;
  close: () => Promise<void>;
  server: Server;
};

async function makeOrchestrator(opts: {
  workspaces: WorkspaceRecord[];
  echoBaseUrl: string;
}): Promise<Orchestrator> {
  const counters = { spawns: 0, nextPort: 60000 };
  const childRegistry: ChildProcess[] = [];
  // F2Ú8 — local workspace registry simulates orchestrator state.workspaces +
  // activeId. POST /workspaces appends, POST /workspaces/:id/activate updates
  // activeId. Surrogate doesn't persist (F2Ú6 is tested elsewhere).
  const workspaces = new Map<string, WorkspaceRecord>(
    opts.workspaces.map((w) => [w.id, w]),
  );
  let activeId: string | null = null;

  const pool = new EnginePool({
    deps: {
      resolveWorkspace: async (ws) => ({
        workdir: ws.path ?? `/tmp/${ws.id}`,
        configDir: `/tmp/cfg/${ws.id}`,
      }),
      spawnEngine: async ({ port }) => {
        counters.spawns++;
        // Long-lived child for isProcessAlive(pid) + stopChild semantics.
        // baseUrl points to shared echo server (not this child) — pool just
        // tracks the process for lifecycle.
        const child = spawn("node", ["-e", "process.stdin.resume()"], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        childRegistry.push(child);
        void port;
        return { child, baseUrl: opts.echoBaseUrl };
      },
      waitForHealthy: async () => {},
      stopChild,
      findFreePort: async () => counters.nextPort++,
      isProcessAlive,
    },
    config: {
      // Disable background loops — exit gate doesn't exercise idle/health
      // (those are in engine-pool.test.ts F2Ú4/F2Ú5).
      idleSweepIntervalMs: 999_999,
      healthIntervalMs: 999_999,
    },
  });

  const server = createServer(async (req, res) => {
    res.setHeader("connection", "close");
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parts = url.pathname.split("/").filter(Boolean);

    const sendJson = (status: number, payload: unknown): void => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(200, { engines: pool.snapshot(), activeId });
      return;
    }

    // F2Ú3 surrogate: POST /workspaces — pro úplnost (Tauri to volá při
    // activateWorkspace). Vrací already-known workspace nebo 404.
    if (req.method === "POST" && url.pathname === "/workspaces") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      const existing = Array.from(workspaces.values()).find(
        (w) => w.path === body.path,
      );
      if (!existing) {
        sendJson(404, { error: "workspace not found in test surrogate" });
        return;
      }
      sendJson(200, { activeId, workspace: existing });
      return;
    }

    // F2Ú3 surrogate: POST /workspaces/:id/activate — jen update activeId,
    // žádný spawn (pool je lazy).
    if (
      parts[0] === "workspaces" &&
      parts.length === 3 &&
      parts[2] === "activate" &&
      req.method === "POST"
    ) {
      const wsId = decodeURIComponent(parts[1] ?? "");
      const ws = workspaces.get(wsId);
      if (!ws) {
        sendJson(404, { error: "workspace not found" });
        return;
      }
      activeId = ws.id;
      sendJson(200, { activeId, workspace: ws });
      return;
    }

    // F2Ú2 routing proxy.
    if (parts[0] === "workspace" && parts.length >= 3 && parts[2] === "opencode") {
      const ws = workspaces.get(decodeURIComponent(parts[1] ?? ""));
      if (!ws) {
        sendJson(404, { error: "workspace not found" });
        return;
      }
      if (ws.type === "remote") {
        sendJson(501, { error: "remote not pooled" });
        return;
      }
      let engine;
      try {
        engine = await pool.ensure({ id: ws.id, path: ws.path });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const status = detail.includes("capacity exceeded") ? 503 : 502;
        sendJson(status, { error: "engine spawn failed", detail });
        return;
      }
      const restPath = "/" + parts.slice(3).join("/");
      proxyToEngine({
        clientReq: req,
        clientRes: res,
        targetBaseUrl: engine.baseUrl,
        targetPath: restPath,
        targetSearch: url.search,
        injectHeaders: {
          "x-opencode-directory": ws.path,
          "x-veslo-workspace-id": ws.id,
        },
        onSuccess: () => pool.touch(ws.id),
      });
      return;
    }

    sendJson(404, { error: "not found" });
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    pool,
    server,
    close: async () => {
      await pool.killAll();
      try {
        server.close();
      } catch {
        // see EchoServer comment
      }
      await Promise.all(childRegistry.map((c) => stopChild(c)));
    },
  };
}

type Resources = { echo: EchoServer; orch: Orchestrator };
const resources: Resources[] = [];

afterEach(async () => {
  while (resources.length > 0) {
    const r = resources.pop()!;
    await r.orch.close();
    await r.echo.close();
  }
});

async function setup(workspaces: WorkspaceRecord[]): Promise<Resources> {
  const echo = await makeEchoServer();
  const orch = await makeOrchestrator({ workspaces, echoBaseUrl: echo.baseUrl });
  const r = { echo, orch };
  resources.push(r);
  return r;
}

// === Tests ===

describe("F2Ú8 — exit gate: paralelní workspaces (Václavův scénář)", () => {
  test("Václav: long-running A nesmí blokovat B", async () => {
    const { echo, orch } = await setup([
      { id: "ws-A", path: "/tmp/ws-A", type: "local" },
      { id: "ws-B", path: "/tmp/ws-B", type: "local" },
    ]);
    // Echo handler: pokud header `x-test-delay-ms`, počkat tak dlouho.
    echo.setHandler((req, res) => {
      const delayMs = Number(req.headers["x-test-delay-ms"] ?? "0");
      const wsId = req.headers["x-veslo-workspace-id"] ?? "?";
      setTimeout(() => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ws: wsId, delayMs }));
      }, delayMs);
    });

    // Start long request na A bez čekání. Echo simuluje 2s agent run.
    const startA = Date.now();
    const promiseA = fetch(`${orch.baseUrl}/workspace/ws-A/opencode/long-task`, {
      headers: { "x-test-delay-ms": "2000" },
    });

    // Krátká pauza aby A request odešel + engine A se spawnnul (cold start).
    await new Promise((r) => setTimeout(r, 100));

    // Bez čekání na A → request na B s rychlou response.
    const startB = Date.now();
    const responseB = await fetch(`${orch.baseUrl}/workspace/ws-B/opencode/quick`, {
      headers: { "x-test-delay-ms": "20" },
    });
    const elapsedB = Date.now() - startB;

    // Klíčový invariant Václav scénáře: B se vrátí < 500ms, není blokována A.
    expect(responseB.status).toBe(200);
    expect(elapsedB).toBeLessThan(500);

    // Pool má teď oba enginy ready, různé porty/pidy — paralelní pool.
    expect(orch.pool.size()).toBe(2);
    const engineA = orch.pool.get("ws-A");
    const engineB = orch.pool.get("ws-B");
    expect(engineA?.state).toBe("ready");
    expect(engineB?.state).toBe("ready");
    expect(engineA?.pid).not.toBe(engineB?.pid);
    expect(engineA?.port).not.toBe(engineB?.port);

    // Až teď čekáme na A. Ověříme že stále dorazila s correct payload.
    const responseA = await promiseA;
    const elapsedA = Date.now() - startA;
    expect(responseA.status).toBe(200);
    const bodyA = (await responseA.json()) as { ws: string; delayMs: number };
    expect(bodyA.ws).toBe("ws-A");
    expect(bodyA.delayMs).toBe(2000);

    // A trvala minimálně 2s (delay), B byla rychle — paralelism dokázán.
    expect(elapsedA).toBeGreaterThanOrEqual(2000);
  });

  test("engine reuse: sekvenční requesty na A nepustí nový spawn", async () => {
    const { orch } = await setup([
      { id: "ws-A", path: "/tmp/ws-A", type: "local" },
    ]);

    const pidsObserved = new Set<number>();
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${orch.baseUrl}/workspace/ws-A/opencode/req-${i}`);
      expect(res.status).toBe(200);
      const engine = orch.pool.get("ws-A");
      if (engine?.pid) pidsObserved.add(engine.pid);
    }

    // 5 sekvenčních requestů, pool zůstává 1 engine, stejný pid.
    expect(orch.pool.size()).toBe(1);
    expect(pidsObserved.size).toBe(1);
    expect(orch.pool.get("ws-A")?.state).toBe("ready");
  });
});
