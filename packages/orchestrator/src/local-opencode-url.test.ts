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
    const cliSource = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");
    const hostModeSource = cliSource.slice(cliSource.indexOf("} else {\n      const opencodeChild"));
    const routerStart = extractCall(hostModeSource, "opencodeRouterChild = await startOpenCodeRouter({");
    const serverStart = extractCall(hostModeSource, "const vesloChild = await startVesloServer({");
    const serverVerify = extractCall(hostModeSource, "vesloActualVersion = await verifyVesloServer({");

    expect(routerStart).toContain("opencodeUrl: opencodeBaseUrl");
    expect(serverStart).toContain("opencodeBaseUrl: opencodeBaseUrl");
    expect(serverVerify).toContain("expectedOpencodeBaseUrl: opencodeBaseUrl");
    expect(routerStart).not.toContain("opencodeUrl: opencodeConnectUrl");
    expect(serverStart).not.toContain("opencodeBaseUrl: opencodeConnectUrl");
    expect(serverVerify).not.toContain("expectedOpencodeBaseUrl: opencodeConnectUrl");
  });

  test("daemon stores a loopback client URL when OpenCode binds to all interfaces", () => {
    const cliSource = readFileSync(new URL("./cli.ts", import.meta.url), "utf8");

    expect(cliSource).toContain("const opencodeClientHost = localClientHostForBindHost(opencodeHost)");
    expect(cliSource).toContain("const baseUrl = `http://${opencodeClientHost}:${opencodePort}`");
    expect(cliSource).not.toContain("const baseUrl = `http://${opencodeHost}:${opencodePort}`");
  });
});
