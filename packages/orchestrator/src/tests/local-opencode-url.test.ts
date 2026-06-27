import { readFileSync } from "node:fs";

import { describe, expect, test } from "bun:test";

function extractCall(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("});", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("local OpenCode URL wiring", () => {
  test("host-mode sidecars use loopback OpenCode URL for internal calls", () => {
    const cliSource = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
    const routerStart = extractCall(cliSource, "opencodeRouterChild = await startOpenCodeRouter({");
    const serverStart = extractCall(cliSource, "const vesloChild = await startVesloServer({");
    const serverVerify = extractCall(cliSource, "vesloActualVersion = await verifyVesloServer({");

    expect(routerStart).toContain("opencodeUrl: opencodeBaseUrl");
    expect(serverStart).toContain("opencodeBaseUrl: opencodeBaseUrl");
    expect(serverStart).toContain("sandboxBackend: resolveEnginePathMappingBackend({");
    expect(serverVerify).toContain("expectedOpencodeBaseUrl: opencodeBaseUrl");
    expect(routerStart).not.toContain("opencodeUrl: opencodeConnectUrl");
    expect(serverStart).not.toContain("opencodeBaseUrl: opencodeConnectUrl");
    expect(serverVerify).not.toContain("expectedOpencodeBaseUrl: opencodeConnectUrl");
  });

  test("daemon stores a loopback client URL when OpenCode binds to all interfaces", () => {
    const cliSource = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

    expect(cliSource).toContain("const opencodeClientHost = localClientHostForBindHost(opencodeHost)");
    expect(cliSource).toContain("const opencodeBaseUrl = `http://127.0.0.1:${opencodePort}`");
    expect(cliSource).not.toContain("const opencodeBaseUrl = `http://${opencodeHost}:${opencodePort}`");
  });

  test("sandbox launch failures fall back to unsandboxed engine wiring", () => {
    const cliSource = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

    expect(cliSource).toContain("sandbox launch unavailable, spawning unsandboxed");
    expect(cliSource).toContain("buildUnsandboxedSandboxWarning");
    expect(cliSource).toContain("configuredSandboxBackend");
    expect(cliSource).toContain("effectiveSandboxBackend");
    expect(cliSource).toContain("sandboxMode");
    expect(cliSource).toContain("sandboxFallbackReason");
    expect(cliSource).toContain("engineChildKind: proxyTarget.engine.childKind ?? \"direct\"");
    expect(cliSource).toContain("engineChildKind: engine.childKind ?? \"direct\"");
  });

  test("Veslo server OpenCode Router proxy uses the server-owned route namespace", () => {
    const cliSource = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");

    expect(cliSource).toContain("/opencode-router/health");
    expect(cliSource).toContain("/opencode-router/identities/telegram");
    expect(cliSource).toContain("/opencode-router/identities/slack");
    expect(cliSource).toContain("/opencode-router/config/groups");
    expect(cliSource).toContain("/w/${encodeURIComponent(workspaceId)}/opencode-router");
    expect(cliSource).not.toMatch(/[`'"][^`'"]*\/veslo-code-router/);
  });
});
