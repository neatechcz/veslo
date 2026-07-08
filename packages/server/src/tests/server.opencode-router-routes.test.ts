import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerOpenCodeRouterRoutes } from "../routes/opencode-router.js";
import { matchRoute, type RequestContext, type Route } from "../routing.js";
import type { ServerConfig } from "../types.js";

const tempDirs: string[] = [];
let previousOpenCodeRouterConfigPath: string | undefined;

afterEach(async () => {
  if (previousOpenCodeRouterConfigPath === undefined) {
    delete process.env.OPENCODE_ROUTER_CONFIG_PATH;
  } else {
    process.env.OPENCODE_ROUTER_CONFIG_PATH = previousOpenCodeRouterConfigPath;
  }
  previousOpenCodeRouterConfigPath = undefined;

  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("OpenCode Router workspace routes", () => {
  test("registers the workspace OpenCode Router contract under /opencode-router", () => {
    const routes: Route[] = [];
    registerOpenCodeRouterRoutes(routes);

    expect(routes).toHaveLength(13);

    const expectedRoutes = [
      ["POST", "/workspace/demo/opencode-router/telegram-token"],
      ["GET", "/workspace/demo/opencode-router/telegram"],
      ["POST", "/workspace/demo/opencode-router/telegram-enabled"],
      ["POST", "/workspace/demo/opencode-router/slack-tokens"],
      ["GET", "/workspace/demo/opencode-router/identities/telegram"],
      ["POST", "/workspace/demo/opencode-router/identities/telegram"],
      ["DELETE", "/workspace/demo/opencode-router/identities/telegram/alice"],
      ["GET", "/workspace/demo/opencode-router/identities/slack"],
      ["POST", "/workspace/demo/opencode-router/identities/slack"],
      ["DELETE", "/workspace/demo/opencode-router/identities/slack/bob"],
      ["GET", "/workspace/demo/opencode-router/bindings"],
      ["POST", "/workspace/demo/opencode-router/bindings"],
      ["POST", "/workspace/demo/opencode-router/send"],
    ] as const;

    for (const [method, path] of expectedRoutes) {
      const route = matchRoute(routes, method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe("client");
      expect(route?.params.id).toBe("demo");
    }

    expect(matchRoute(routes, "GET", "/workspace/demo/veslo-code-router/identities/telegram")).toBeNull();
    expect(matchRoute(routes, "POST", "/workspace/demo/veslo-code-router/send")).toBeNull();
  });

  test("narrows persisted Telegram and Slack identity arrays from config fallback", async () => {
    const fixture = await createFixture({
      channels: {
        telegram: {
          bots: [
            null,
            "not-an-object",
            { id: "other", token: "other-token", enabled: true },
            {
              id: "demo",
              token: "telegram-token",
              enabled: "true",
              access: "private",
              pairingCodeHash: "a".repeat(64),
            },
          ],
        },
        slack: {
          apps: [
            false,
            { id: "other", botToken: "x", appToken: "xapp", enabled: true },
            { id: "demo", botToken: "bot", appToken: "app", enabled: "false" },
          ],
        },
      },
    });

    const telegram = await invokeJson(fixture, "GET", "/workspace/demo/opencode-router/identities/telegram?healthPort=9");
    const slack = await invokeJson(fixture, "GET", "/workspace/demo/opencode-router/identities/slack?healthPort=9");

    expect(telegram.items).toEqual([
      {
        id: "demo",
        enabled: true,
        running: false,
        access: "private",
        pairingRequired: true,
      },
    ]);
    expect(slack.items).toEqual([{ id: "demo", enabled: false, running: false }]);
  });
});

type Fixture = {
  routes: Route[];
  config: ServerConfig;
};

async function createFixture(opencodeRouterConfig: Record<string, unknown>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "veslo-opencode-router-route-"));
  tempDirs.push(root);
  const workspaceRoot = join(root, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const configPath = join(root, "opencode-router.json");
  await writeFile(configPath, `${JSON.stringify({ version: 1, ...opencodeRouterConfig }, null, 2)}\n`, "utf8");

  previousOpenCodeRouterConfigPath = process.env.OPENCODE_ROUTER_CONFIG_PATH;
  process.env.OPENCODE_ROUTER_CONFIG_PATH = configPath;

  const routes: Route[] = [];
  registerOpenCodeRouterRoutes(routes);
  return {
    routes,
    config: serverConfig(workspaceRoot),
  };
}

async function invokeJson(fixture: Fixture, method: string, path: string): Promise<Record<string, unknown>> {
  const url = new URL(`http://127.0.0.1${path}`);
  const route = matchRoute(fixture.routes, method, url.pathname);
  expect(route).not.toBeNull();
  const response = await route!.handler({
    request: new Request(url, { method }),
    url,
    params: route!.params,
    config: fixture.config,
    approvals: {} as RequestContext["approvals"],
    reloadEvents: {} as RequestContext["reloadEvents"],
    tokens: {} as RequestContext["tokens"],
    automationRunner: {} as RequestContext["automationRunner"],
    actor: { type: "remote", clientId: "test-client", tokenHash: "test-token", scope: "collaborator" },
  });
  expect(response.status).toBe(200);
  return await response.json() as Record<string, unknown>;
}

function serverConfig(workspaceRoot: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: "token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: [],
    workspaces: [{ id: "demo", name: "Demo", path: workspaceRoot, workspaceType: "local" }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "json",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 100,
      batchMaxBytes: 1024 * 1024,
      spoolMaxBytes: 1024 * 1024,
      flushIntervalMs: 1000,
    },
  };
}
