import { expect, test } from "bun:test";

import { routerRequestObservation, routerRouteFamily } from "../router-request-observability.js";

test("router request observation keeps correlation while excluding raw path and workspace identity", () => {
  const rawPath = "/workspace/ws-secret/opencode/session/ses-secret/message?token=not-for-logs";
  const observation = routerRequestObservation({
    method: "POST",
    pathname: rawPath,
    status: 200,
    durationMs: 12.7,
    sendTraceHeader: "trace-1234-abcd",
    activeWorkspaceId: "ws-secret",
  });

  expect(observation.attributes).toEqual({
    method: "POST",
    routeFamily: "workspace-opencode-proxy",
    status: 200,
    durationMs: 13,
    traceId: "trace-1234-abcd",
    activeWorkspaceIdDigest: "e3afe28964f75f78",
  });
  expect(observation.message).toContain("traceId=trace-1234-abcd");
  expect(JSON.stringify(observation)).not.toContain(rawPath);
  expect(JSON.stringify(observation)).not.toContain("ws-secret");
  expect(JSON.stringify(observation)).not.toContain("not-for-logs");
});

test("router request observation rejects arbitrary correlation header values", () => {
  const observation = routerRequestObservation({
    method: "GET",
    pathname: "/health",
    status: 200,
    durationMs: -1,
    sendTraceHeader: "prompt=do not persist this",
    activeWorkspaceId: "",
  });

  expect(routerRouteFamily("/workspaces/ws-a/activate")).toBe("workspace-management");
  expect(observation.attributes.traceId).toBeNull();
  expect(observation.attributes.activeWorkspaceIdDigest).toBeNull();
  expect(observation.message).toBe("Router request GET health status=200 durationMs=0 traceId=none activeWorkspace=none");
});
