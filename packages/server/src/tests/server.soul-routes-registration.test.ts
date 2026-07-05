import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import { registerSoulRoutes } from "../routes/soul.js";

describe("Soul routes", () => {
  test("registers the Soul runtime and memory contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerSoulRoutes>[1];

    registerSoulRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/soul", "client"],
      ["GET", "/soul/organization", "client"],
      ["GET", "/soul/user", "client"],
      ["GET", "/soul/workspaces", "client"],
      ["GET", "/workspace/ws_1/soul", "client"],
      ["POST", "/workspace/ws_1/soul/materialization/sync", "client"],
      ["GET", "/soul/user/versions", "client"],
      ["GET", "/soul/user/versions/version-1", "client"],
      ["PATCH", "/soul/organization", "client"],
      ["PATCH", "/soul/user", "client"],
      ["POST", "/soul/organization/versions/version-1/restore", "client"],
      ["POST", "/soul/user/versions/version-1/restore", "client"],
      ["PATCH", "/workspace/ws_1/soul", "client"],
      ["POST", "/workspace/ws_1/soul/versions/version-1/restore", "client"],
      ["POST", "/workspace/ws_1/soul/heartbeat-toggle", "client"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "DELETE", "/workspace/ws_1/soul")).toBeNull();
  });
});
