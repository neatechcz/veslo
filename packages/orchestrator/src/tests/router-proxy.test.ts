import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

import { EnginePool } from "../engine-pool.js";
import { proxyToEngine } from "../router-proxy.js";

type EchoCapture = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

type EchoServer = {
  port: number;
  baseUrl: string;
  captures: EchoCapture[];
  close: () => Promise<void>;
  /** Replace the default JSON-echo handler (e.g. for streaming tests) */
  setHandler: (handler: (req: IncomingMessage, res: ServerResponse) => void) => void;
};

async function makeEchoServer(): Promise<EchoServer> {
  const captures: EchoCapture[] = [];
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;

  const server = createServer((req, res) => {
    res.setHeader("connection", "close");
    if (handler) {
      handler(req, res);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      captures.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ method: req.method, path: req.url, body }));
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    captures,
    close: async () => {
      // server.unref() above lets the process exit without explicit close;
      // bun:test invokes process termination after suite, OS reclaims port.
      // Calling server.close() here hangs under Bun's node:http compat
      // when keep-alive sockets are still in TIME_WAIT.
      try {
        server.close();
      } catch {
        // ignore
      }
    },
    setHandler: (h) => {
      handler = h;
    },
  };
}

type Orchestrator = {
  port: number;
  baseUrl: string;
  pool: EnginePool;
  close: () => Promise<void>;
  server: Server;
};

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
  child.kill("SIGTERM");
  const exited = await Promise.race([
    once(child, "exit").then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
  if (exited) return;
  child.kill("SIGKILL");
  await Promise.race([once(child, "exit"), delay(timeoutMs)]);
}

type WorkspaceRecord = { id: string; path: string; type: "local" | "remote" };

async function makeOrchestrator(opts: {
  workspaces: WorkspaceRecord[];
  echoBaseUrl: string;
}): Promise<Orchestrator> {
  const counters = { spawns: 0, nextPort: 60000 };
  const childRegistry: ChildProcess[] = [];

  const pool = new EnginePool({
    deps: {
      resolveWorkspace: async (ws) => ({
        workdir: ws.path ?? `/tmp/${ws.id}`,
        configDir: `/tmp/cfg/${ws.id}`,
      }),
      spawnEngine: async ({ port }) => {
        counters.spawns++;
        // Spawn long-lived child; baseUrl points to the SHARED fake echo server,
        // not to this child. The child only exists so that `isProcessAlive(pid)`
        // returns true and stopChild has something to kill.
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
  });

  const server = createServer(async (req, res) => {
    res.setHeader("connection", "close");
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ engines: pool.snapshot() }));
      return;
    }

    if (parts[0] === "workspace" && parts.length >= 3 && parts[2] === "opencode") {
      const ws = opts.workspaces.find(
        (w) => w.id === decodeURIComponent(parts[1] ?? ""),
      );
      if (!ws) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "workspace not found" }));
        return;
      }
      if (ws.type === "remote") {
        res.statusCode = 501;
        res.end(JSON.stringify({ error: "remote not pooled" }));
        return;
      }
      // Send-timeout fix 2026-06-10 (mirrors cli.ts): GET/HEAD never spawn —
      // background polls fail fast with 503 instead of waiting on a cold start.
      const method = (req.method ?? "GET").toUpperCase();
      let engine;
      if (method === "GET" || method === "HEAD") {
        engine = pool.getRunning(ws.id);
        if (!engine) {
          res.statusCode = 503;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "engine_not_running", workspaceId: ws.id }));
          return;
        }
      } else {
        engine = await pool.ensure({ id: ws.id, path: ws.path });
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

    // F2Ú3 surrogate: minimální handler pro activate (jen update activeId, žádný spawn).
    if (
      parts[0] === "workspaces" &&
      parts.length === 3 &&
      parts[2] === "activate" &&
      req.method === "POST"
    ) {
      const ws = opts.workspaces.find(
        (w) => w.id === decodeURIComponent(parts[1] ?? ""),
      );
      if (!ws) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "workspace not found" }));
        return;
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ activeId: ws.id, workspace: ws }));
      return;
    }

    // F2Ú3 surrogate: dispose mapuje na pool.suspend (kill engine, lazy respawn).
    if (
      parts[0] === "instances" &&
      parts.length === 3 &&
      parts[2] === "dispose" &&
      req.method === "POST"
    ) {
      const ws = opts.workspaces.find(
        (w) => w.id === decodeURIComponent(parts[1] ?? ""),
      );
      if (!ws) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "workspace not found" }));
        return;
      }
      if (ws.type === "local") {
        await pool.suspend(ws.id);
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ disposed: true }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });

  server.keepAliveTimeout = 1;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    pool,
    server,
    close: async () => {
      await pool.killAll();
      try {
        server.close();
      } catch {
        // ignore — see makeEchoServer comment
      }
      await Promise.all(childRegistry.map((c) => stopChild(c)));
    },
  };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  return { status: res.status, body, headers: res.headers };
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

describe("router proxy + EnginePool integration", () => {
  test("GET /workspace/:id/opencode/* routes to engine, injects directory header", async () => {
    const { echo, orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    await orch.pool.ensure({ id: "ws-a", path: "/tmp/ws-a" });
    const res = await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/app`);
    expect(res.status).toBe(200);
    expect(echo.captures).toHaveLength(1);
    const cap = echo.captures[0]!;
    expect(cap.path).toBe("/app");
    expect(cap.method).toBe("GET");
    expect(cap.headers["x-opencode-directory"]).toBe("/tmp/ws-a");
    expect(cap.headers["x-veslo-workspace-id"]).toBe("ws-a");
  });

  test("directory query override does not change the workspace engine root", async () => {
    const { echo, orch } = await setup([
      { id: "ws-root", path: "/tmp/ws-root", type: "local" },
    ]);
    await orch.pool.ensure({ id: "ws-root", path: "/tmp/ws-root" });
    const res = await fetchJson(
      `${orch.baseUrl}/workspace/ws-root/opencode/session?directory=${encodeURIComponent("/tmp/ws-root/.opencode")}&limit=20`,
    );

    expect(res.status).toBe(200);
    expect(orch.pool.size()).toBe(1);
    expect(orch.pool.get("ws-root")?.workdir).toBe("/tmp/ws-root");
    expect(echo.captures).toHaveLength(1);
    const cap = echo.captures[0]!;
    expect(cap.path).toBe("/session?directory=%2Ftmp%2Fws-root%2F.opencode&limit=20");
    expect(cap.headers["x-opencode-directory"]).toBe("/tmp/ws-root");
    expect(cap.headers["x-veslo-workspace-id"]).toBe("ws-root");
  });

  test("second request reuses engine (no respawn)", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/a`, { method: "POST" });
    const beforePid = orch.pool.get("ws-a")?.pid;
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/b`);
    const afterPid = orch.pool.get("ws-a")?.pid;
    expect(afterPid).toBe(beforePid);
    expect(orch.pool.size()).toBe(1);
  });

  test("different workspaces spawn separate engines", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
      { id: "ws-b", path: "/tmp/ws-b", type: "local" },
    ]);
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/x`, { method: "POST" });
    await fetchJson(`${orch.baseUrl}/workspace/ws-b/opencode/x`, { method: "POST" });
    expect(orch.pool.size()).toBe(2);
    expect(orch.pool.get("ws-a")?.pid).not.toBe(orch.pool.get("ws-b")?.pid);
  });

  test("concurrent requests on different workspaces resolve independently", async () => {
    const { echo, orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
      { id: "ws-b", path: "/tmp/ws-b", type: "local" },
    ]);
    // Slow down echo to simulate long-running work
    echo.setHandler((req, res) => {
      const isA = req.headers["x-veslo-workspace-id"] === "ws-a";
      const delayMs = isA ? 200 : 20;
      setTimeout(() => {
        res.statusCode = 200;
        res.end(JSON.stringify({ ws: req.headers["x-veslo-workspace-id"] }));
      }, delayMs);
    });
    await orch.pool.ensure({ id: "ws-a", path: "/tmp/ws-a" });
    await orch.pool.ensure({ id: "ws-b", path: "/tmp/ws-b" });
    const start = Date.now();
    const [a, b] = await Promise.all([
      fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/long`),
      fetchJson(`${orch.baseUrl}/workspace/ws-b/opencode/fast`),
    ]);
    const elapsed = Date.now() - start;
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(elapsed).toBeLessThan(500);
  });

  test("POST body is forwarded to engine intact", async () => {
    const { echo, orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    const payload = JSON.stringify({ hello: "world", n: 42 });
    const res = await fetch(`${orch.baseUrl}/workspace/ws-a/opencode/echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(res.status).toBe(200);
    expect(echo.captures[0]?.body).toBe(payload);
    expect(echo.captures[0]?.method).toBe("POST");
  });

  test("SSE-like streaming chunks pass through", async () => {
    const { echo, orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    echo.setHandler((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write("data: one\n\n");
      setTimeout(() => {
        res.write("data: two\n\n");
        setTimeout(() => {
          res.write("data: three\n\n");
          res.end();
        }, 30);
      }, 30);
    });
    await orch.pool.ensure({ id: "ws-a", path: "/tmp/ws-a" });
    const res = await fetch(`${orch.baseUrl}/workspace/ws-a/opencode/event`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    expect(text).toContain("data: one");
    expect(text).toContain("data: two");
    expect(text).toContain("data: three");
  });

  test("/health reports engine snapshot after activity", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
      { id: "ws-b", path: "/tmp/ws-b", type: "local" },
    ]);
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/ping`, { method: "POST" });
    await fetchJson(`${orch.baseUrl}/workspace/ws-b/opencode/ping`, { method: "POST" });
    const health = await fetchJson(`${orch.baseUrl}/health`);
    const engines = (health.body as { engines: Array<{ workspaceId: string; state: string }> })
      .engines;
    expect(engines).toHaveLength(2);
    const ids = engines.map((e) => e.workspaceId).sort();
    expect(ids).toEqual(["ws-a", "ws-b"]);
    for (const e of engines) expect(e.state).toBe("ready");
  });

  test("remote workspace returns 501", async () => {
    const { orch } = await setup([
      { id: "ws-r", path: "", type: "remote" },
    ]);
    const res = await fetchJson(`${orch.baseUrl}/workspace/ws-r/opencode/x`);
    expect(res.status).toBe(501);
  });

  test("unknown workspace returns 404", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    const res = await fetchJson(`${orch.baseUrl}/workspace/ws-missing/opencode/x`);
    expect(res.status).toBe(404);
  });

  test("upstream failure returns 502", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    // First spawn an engine (so pool.ensure resolves), then point its baseUrl
    // at a dead port to force ECONNREFUSED on proxy.
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/warmup`, { method: "POST" });
    const engine = orch.pool.get("ws-a")!;
    engine.baseUrl = "http://127.0.0.1:1"; // unbound on most systems
    const res = await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/fail`);
    expect(res.status).toBe(502);
  });

  // F2Ú3: activate endpoint je teď pure state update — žádný kill+spawn.
  test("activate updates activeId without spawning engine (F2Ú3)", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
      { id: "ws-b", path: "/tmp/ws-b", type: "local" },
    ]);
    expect(orch.pool.size()).toBe(0);

    const res = await fetchJson(`${orch.baseUrl}/workspaces/ws-a/activate`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ activeId: "ws-a" });
    // Klíčový invariant F2Ú3: activate nesmí spawnnout engine.
    expect(orch.pool.size()).toBe(0);

    // Send-timeout fix: GET nespawnuje — fail-fast 503.
    const getRes = await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/x`);
    expect(getRes.status).toBe(503);
    expect(orch.pool.size()).toBe(0);

    // Až non-GET proxy request spawne (lazy).
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/x`, { method: "POST" });
    expect(orch.pool.size()).toBe(1);
  });

  // F2Ú3: dispose mapuje na pool.suspend (kill engine, lazy respawn).
  test("dispose suspends pooled engine and lazy-respawns on next request (F2Ú3)", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/warmup`, { method: "POST" });
    const firstPid = orch.pool.get("ws-a")?.pid;
    expect(firstPid).toBeGreaterThan(0);

    const disposeRes = await fetchJson(`${orch.baseUrl}/instances/ws-a/dispose`, {
      method: "POST",
    });
    expect(disposeRes.status).toBe(200);
    expect(disposeRes.body).toMatchObject({ disposed: true });
    expect(orch.pool.get("ws-a")?.state).toBe("suspended");

    // Send-timeout fix: GET po dispose nerespawnuje — fail-fast 503.
    const getRes = await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/poll`);
    expect(getRes.status).toBe(503);
    expect(orch.pool.get("ws-a")?.state).toBe("suspended");

    // Další non-GET request engine respawne (jiný pid).
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/again`, { method: "POST" });
    const secondPid = orch.pool.get("ws-a")?.pid;
    expect(secondPid).toBeGreaterThan(0);
    expect(secondPid).not.toBe(firstPid);
    expect(orch.pool.get("ws-a")?.state).toBe("ready");
  });

  // Send-timeout fix 2026-06-10: background polls (GET /mcp, /permission, …)
  // must fail fast instead of cold-spawning an engine and blocking up to 60s.
  test("GET/HEAD proxy without running engine returns 503 immediately, no spawn", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    const start = Date.now();
    const getRes = await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/mcp`);
    expect(getRes.status).toBe(503);
    expect(getRes.body).toMatchObject({ error: "engine_not_running", workspaceId: "ws-a" });
    const headRes = await fetch(`${orch.baseUrl}/workspace/ws-a/opencode/permission`, {
      method: "HEAD",
    });
    expect(headRes.status).toBe(503);
    // No engine spawned and no cold-start wait happened.
    expect(orch.pool.size()).toBe(0);
    expect(Date.now() - start).toBeLessThan(2_000);
  });

  test("POST proxy without running engine spawns lazily (send path keeps working)", async () => {
    const { echo, orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    const res = await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(200);
    expect(orch.pool.size()).toBe(1);
    expect(orch.pool.get("ws-a")?.state).toBe("ready");
    expect(echo.captures[0]?.method).toBe("POST");

    // Once the engine runs, GET polls pass through normally.
    const getRes = await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/mcp`);
    expect(getRes.status).toBe(200);
  });

  // F2Ú3: dispose for unknown workspace is 404, no side effect.
  test("dispose for unknown workspace returns 404 (F2Ú3)", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    const res = await fetchJson(`${orch.baseUrl}/instances/ws-missing/dispose`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
    expect(orch.pool.size()).toBe(0);
  });
});

describe("proxyToEngine — unit-level edge cases", () => {
  test("strips configured incoming headers", async () => {
    let captured: Record<string, string | string[] | undefined> | null = null;
    const target = createServer((req, res) => {
      captured = req.headers;
      res.end("ok");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    target.unref();
    const port = (target.address() as AddressInfo).port;

    const front = createServer((req, res) => {
      proxyToEngine({
        clientReq: req,
        clientRes: res,
        targetBaseUrl: `http://127.0.0.1:${port}`,
        targetPath: "/",
        stripIncomingHeaders: ["x-secret"],
        injectHeaders: { "x-injected": "yes" },
      });
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    front.unref();
    const frontPort = (front.address() as AddressInfo).port;

    await fetch(`http://127.0.0.1:${frontPort}/`, {
      headers: { "x-secret": "hidden", "x-keep": "yes" },
    });

    expect(captured).not.toBeNull();
    expect(captured!["x-secret"]).toBeUndefined();
    expect(captured!["x-keep"]).toBe("yes");
    expect(captured!["x-injected"]).toBe("yes");
    expect(captured!["host"]).toBeDefined();
    expect((captured!["host"] as string).startsWith("127.0.0.1:")).toBe(true);

    front.unref();
    target.unref();
    try { front.close(); } catch { /* see EchoServer comment */ }
    try { target.close(); } catch { /* see EchoServer comment */ }
  });

  test("onSuccess fires when upstream response ends", async () => {
    let onSuccessCalls = 0;
    const target = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    target.unref();
    const port = (target.address() as AddressInfo).port;

    const front = createServer((req, res) => {
      proxyToEngine({
        clientReq: req,
        clientRes: res,
        targetBaseUrl: `http://127.0.0.1:${port}`,
        targetPath: "/",
        onSuccess: () => {
          onSuccessCalls++;
        },
      });
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    front.unref();
    const frontPort = (front.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${frontPort}/`);
    await res.text();
    // Give the end event a tick to fire
    await delay(20);
    expect(onSuccessCalls).toBe(1);

    front.unref();
    target.unref();
    try { front.close(); } catch { /* see EchoServer comment */ }
    try { target.close(); } catch { /* see EchoServer comment */ }
  });

  test("upstream connection error responds 502 with JSON", async () => {
    const front = createServer((req, res) => {
      proxyToEngine({
        clientReq: req,
        clientRes: res,
        targetBaseUrl: `http://127.0.0.1:1`, // unbound
        targetPath: "/",
      });
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    front.unref();
    const frontPort = (front.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${frontPort}/`);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("upstream engine error");

    front.unref();
    try { front.close(); } catch { /* see EchoServer comment */ }
  });

  test("rewrites JSON request and response bodies", async () => {
    let captured: unknown = null;
    const target = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ directory: "/workspace" }));
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    target.unref();
    const port = (target.address() as AddressInfo).port;

    const front = createServer((req, res) => {
      proxyToEngine({
        clientReq: req,
        clientRes: res,
        targetBaseUrl: `http://127.0.0.1:${port}`,
        targetPath: "/session",
        rewriteJsonBody: (value) => ({ ...(value as Record<string, unknown>), directory: "/workspace" }),
        rewriteJsonResponse: (value) => ({ ...(value as Record<string, unknown>), directory: "C:\\Work\\project" }),
      });
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    front.unref();
    const frontPort = (front.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${frontPort}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ directory: "C:\\Work\\project" }),
    });

    expect(captured).toEqual({ directory: "/workspace" });
    expect(await res.json()).toEqual({ directory: "C:\\Work\\project" });

    front.unref();
    target.unref();
    try { front.close(); } catch { /* see EchoServer comment */ }
    try { target.close(); } catch { /* see EchoServer comment */ }
  });

  test("forces identity encoding when rewriting JSON responses", async () => {
    let acceptEncoding: string | string[] | undefined;
    const target = createServer((req, res) => {
      acceptEncoding = req.headers["accept-encoding"];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    target.unref();
    const port = (target.address() as AddressInfo).port;

    const front = createServer((req, res) => {
      proxyToEngine({
        clientReq: req,
        clientRes: res,
        targetBaseUrl: `http://127.0.0.1:${port}`,
        targetPath: "/session",
        rewriteJsonResponse: (value) => value,
      });
    });
    await new Promise<void>((resolve) => front.listen(0, "127.0.0.1", resolve));
    front.unref();
    const frontPort = (front.address() as AddressInfo).port;

    const res = await fetch(`http://127.0.0.1:${frontPort}/session`, {
      headers: { "accept-encoding": "gzip, deflate, br" },
    });

    expect(await res.json()).toEqual({ ok: true });
    expect(acceptEncoding).toBe("identity");

    front.unref();
    target.unref();
    try { front.close(); } catch { /* see EchoServer comment */ }
    try { target.close(); } catch { /* see EchoServer comment */ }
  });
});

// Suppress unused import warning if httpRequest end up unreferenced in tests
void httpRequest;
