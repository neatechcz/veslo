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

import { EnginePool } from "./engine-pool.js";
import { proxyToEngine } from "./router-proxy.js";

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
      const engine = await pool.ensure({ id: ws.id, path: ws.path });
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
    const res = await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/app`);
    expect(res.status).toBe(200);
    expect(echo.captures).toHaveLength(1);
    const cap = echo.captures[0]!;
    expect(cap.path).toBe("/app");
    expect(cap.method).toBe("GET");
    expect(cap.headers["x-opencode-directory"]).toBe("/tmp/ws-a");
    expect(cap.headers["x-veslo-workspace-id"]).toBe("ws-a");
  });

  test("second request reuses engine (no respawn)", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/a`);
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
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/x`);
    await fetchJson(`${orch.baseUrl}/workspace/ws-b/opencode/x`);
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
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/ping`);
    await fetchJson(`${orch.baseUrl}/workspace/ws-b/opencode/ping`);
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
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/warmup`);
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

    // Až proxy request spawne (lazy).
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/x`);
    expect(orch.pool.size()).toBe(1);
  });

  // F2Ú3: dispose mapuje na pool.suspend (kill engine, lazy respawn).
  test("dispose suspends pooled engine and lazy-respawns on next request (F2Ú3)", async () => {
    const { orch } = await setup([
      { id: "ws-a", path: "/tmp/ws-a", type: "local" },
    ]);
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/warmup`);
    const firstPid = orch.pool.get("ws-a")?.pid;
    expect(firstPid).toBeGreaterThan(0);

    const disposeRes = await fetchJson(`${orch.baseUrl}/instances/ws-a/dispose`, {
      method: "POST",
    });
    expect(disposeRes.status).toBe(200);
    expect(disposeRes.body).toMatchObject({ disposed: true });
    expect(orch.pool.get("ws-a")?.state).toBe("suspended");

    // Další request engine respawne (jiný pid).
    await fetchJson(`${orch.baseUrl}/workspace/ws-a/opencode/again`);
    const secondPid = orch.pool.get("ws-a")?.pid;
    expect(secondPid).toBeGreaterThan(0);
    expect(secondPid).not.toBe(firstPid);
    expect(orch.pool.get("ws-a")?.state).toBe("ready");
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
});

// Suppress unused import warning if httpRequest end up unreferenced in tests
void httpRequest;
