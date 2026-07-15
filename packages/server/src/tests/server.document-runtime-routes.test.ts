import { describe, expect, test } from "bun:test";

import {
  createDocumentRuntimeProviderDependencies,
  createDocumentRuntimeStatusPayload,
  createDocumentRuntimeStatusPayloadFromDoctor,
  createDocumentRuntimeStatusPayloadFromRepair,
  registerDocumentRuntimeRoutes,
  type DocumentRuntimeStatusPayload,
} from "../routes/document-runtime.js";
import { matchRoute, type RequestContext, type Route } from "../routing.js";

describe("Document runtime routes", () => {
  test("registers client-authenticated status and repair endpoints", () => {
    const routes: Route[] = [];

    registerDocumentRuntimeRoutes(routes);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/document-runtime/status", "client"],
      ["POST", "/document-runtime/repair", "client"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }
  });

  test("default status reports missing local runtime without enabling WSL policy", () => {
    const payload = createDocumentRuntimeStatusPayload({
      env: {},
      platform: "win32",
      now: () => new Date("2026-07-02T12:00:00.000Z"),
    });

    expect(payload.status).toBe("missing");
    expect(payload.ready).toBe(false);
    expect(payload.updatedAt).toBe("2026-07-02T12:00:00.000Z");
    expect(payload.package.remoteOnly).toBe(false);
    expect(payload.policy.windowsWslRuntime).toBe("disabled_by_product_policy");
    expect(payload.skills.map((skill) => [skill.id, skill.ready, skill.reason])).toEqual([
      ["veslo-docx", false, "missing"],
      ["veslo-xlsx", false, "missing"],
      ["veslo-pdf", false, "missing"],
      ["veslo-pptx", false, "missing"],
    ]);
  });

  test("explicit remote-only mode stays distinct from ready local runtime", () => {
    const payload = createDocumentRuntimeStatusPayload({
      env: { VESLO_DOCUMENT_RUNTIME_MODE: "remote-docs-only" },
      platform: "darwin",
      now: () => new Date("2026-07-02T12:00:00.000Z"),
    });

    expect(payload.status).toBe("remote_only");
    expect(payload.ready).toBe(false);
    expect(payload.package.remoteOnly).toBe(true);
    expect(payload.policy.windowsWslRuntime).toBe("not_applicable");
    expect(payload.skills.every((skill) => !skill.ready && skill.reason === "remote_only")).toBe(true);
  });

  test("status and repair handlers can be backed by injected runtime providers", async () => {
    const routes: Route[] = [];
    const readyPayload: DocumentRuntimeStatusPayload = {
      ...createDocumentRuntimeStatusPayload({
        status: "ready",
        installedVersion: "2026.7.0",
        activePackage: "veslo-document-runtime-macos-arm64-2026.7.0.veslopkg",
        now: () => new Date("2026-07-02T12:00:00.000Z"),
      }),
      repair: {
        available: true,
        inProgress: false,
        blockedReason: null,
        lastAttemptAt: null,
        lastError: null,
      },
    };

    registerDocumentRuntimeRoutes(routes, {
      readStatus: () => readyPayload,
      repair: () => ({
        ...readyPayload,
        repair: {
          ...readyPayload.repair,
          lastAttemptAt: "2026-07-02T12:01:00.000Z",
        },
      }),
    });

    const statusRoute = matchRoute(routes, "GET", "/document-runtime/status");
    const repairRoute = matchRoute(routes, "POST", "/document-runtime/repair");

    const status = await statusRoute!.handler({} as RequestContext);
    const repair = await repairRoute!.handler({} as RequestContext);

    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(readyPayload);
    expect((await repair.json() as DocumentRuntimeStatusPayload).repair.lastAttemptAt).toBe("2026-07-02T12:01:00.000Z");
  });

  test("maps document runtime doctor results into app diagnostics payloads", () => {
    const ready = createDocumentRuntimeStatusPayloadFromDoctor({
      ok: true,
      status: "ready",
      packageVersion: "2026.7.0",
      activePath: "/runtime/active",
    }, {
      now: () => new Date("2026-07-02T12:00:00.000Z"),
      platform: "darwin",
    });

    expect(ready.status).toBe("ready");
    expect(ready.ready).toBe(true);
    expect(ready.package.installedVersion).toBe("2026.7.0");
    expect(ready.package.activePackage).toBe("/runtime/active");
    expect(ready.repair.available).toBe(false);
    expect(ready.repair.blockedReason).toBeNull();

    const missing = createDocumentRuntimeStatusPayloadFromDoctor({
      ok: false,
      status: "missing",
      checks: [{ ok: false, error: "active pointer missing" }],
    }, {
      now: () => new Date("2026-07-02T12:00:00.000Z"),
      platform: "win32",
    });

    expect(missing.status).toBe("missing");
    expect(missing.ready).toBe(false);
    expect(missing.repair.available).toBe(false);
    expect(missing.repair.blockedReason).toBe("document_runtime_package_repair_requires_updater_provider");
    expect(missing.repair.lastError).toBe("active pointer missing");
    expect(missing.policy.windowsWslRuntime).toBe("disabled_by_product_policy");

    const repairable = createDocumentRuntimeStatusPayloadFromDoctor({
      ok: false,
      status: "missing",
      repairAvailable: true,
      checks: [{ ok: false, error: "active pointer missing" }],
    }, {
      now: () => new Date("2026-07-02T12:00:00.000Z"),
      platform: "win32",
    });

    expect(repairable.status).toBe("missing");
    expect(repairable.repair.available).toBe(true);
    expect(repairable.repair.blockedReason).toBeNull();
  });

  test("maps headless repair attempts without pretending updater repair exists", () => {
    const payload = createDocumentRuntimeStatusPayloadFromRepair({
      ok: false,
      status: "missing",
      repaired: false,
      reason: "Headless package repair requires installer/updater package staging from DRT05.",
      doctor: {
        ok: false,
        status: "missing",
        checks: [{ ok: false, error: "Active runtime directory missing" }],
      },
    }, {
      now: () => new Date("2026-07-02T12:03:00.000Z"),
      platform: "darwin",
    });

    expect(payload.status).toBe("missing");
    expect(payload.repair.available).toBe(false);
    expect(payload.repair.lastAttemptAt).toBe("2026-07-02T12:03:00.000Z");
    expect(payload.repair.blockedReason).toContain("DRT05");
    expect(payload.repair.lastError).toBe("Active runtime directory missing");
  });

  test("provider dependencies call doctor and repairHeadless", async () => {
    const calls: string[] = [];
    const deps = createDocumentRuntimeProviderDependencies(async () => ({
      doctor: () => {
        calls.push("doctor");
        return {
          ok: true,
          status: "ready",
          packageVersion: "2026.7.0",
          activePath: "/runtime/active",
        };
      },
      repairHeadless: () => {
        calls.push("repair");
        return {
          ok: false,
          status: "missing",
          repaired: false,
          reason: "staging unavailable",
          doctor: { ok: false, status: "missing" },
        };
      },
    }), {
      now: () => new Date("2026-07-02T12:04:00.000Z"),
      platform: "darwin",
    });

    const status = await deps.readStatus!({} as RequestContext);
    const repair = await deps.repair!({} as RequestContext);

    expect(calls).toEqual(["doctor", "repair"]);
    expect(status.status).toBe("ready");
    expect(repair.status).toBe("missing");
    expect(repair.repair.lastAttemptAt).toBe("2026-07-02T12:04:00.000Z");
  });

  test("provider dependencies start feed package install without blocking repair responses", async () => {
    const calls: string[] = [];
    let installed = false;
    let finishInstall: (() => void) | null = null;
    const deps = createDocumentRuntimeProviderDependencies(async () => ({
      doctor: () => {
        calls.push("doctor");
        return installed
          ? {
              ok: true,
              status: "ready",
              packageVersion: "2026.7.0",
              activePath: "/runtime/active",
            }
          : {
              ok: false,
              status: "missing",
              checks: [{ ok: false, error: "active pointer missing" }],
            };
      },
      repairHeadless: () => {
        calls.push("repair");
        return { ok: false, status: "missing", repaired: false };
      },
      installPackageFromFeed: (options) => {
        calls.push("install");
        options?.onProgress?.({
          phase: "downloading",
          artifactName: "veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg",
          downloadedBytes: 25,
          totalBytes: 100,
          percent: 25,
          message: "Downloading office document package.",
        });
        return new Promise((resolve) => {
          finishInstall = () => {
            installed = true;
            resolve({
              ok: true,
              status: "ready",
              repaired: true,
              doctor: {
                ok: true,
                status: "ready",
                packageVersion: "2026.7.0",
                activePath: "/runtime/active",
              },
            });
          };
        });
      },
    }), {
      now: () => new Date("2026-07-02T12:05:00.000Z"),
      platform: "win32",
    });

    const missing = await deps.readStatus!({} as RequestContext);
    const repair = await deps.repair!({} as RequestContext);
    const installing = await deps.readStatus!({} as RequestContext);

    expect(missing.status).toBe("missing");
    expect(missing.repair.available).toBe(true);
    expect(repair.status).toBe("package_installing");
    expect(repair.repair.inProgress).toBe(true);
    expect(installing.status).toBe("package_installing");
    expect(installing.package.progress?.phase).toBe("downloading");
    expect(installing.package.progress?.percent).toBe(25);
    expect(calls).toEqual(["doctor", "install"]);

    const resolveInstall = finishInstall ?? (() => {
      throw new Error("Expected document runtime package install to start.");
    });
    resolveInstall();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ready = await deps.readStatus!({} as RequestContext);

    expect(ready.status).toBe("ready");
    expect(ready.ready).toBe(true);
    expect(calls).toEqual(["doctor", "install", "doctor"]);
  });

  test("provider dependencies do not offer package install in remote-only mode", async () => {
    const calls: string[] = [];
    const deps = createDocumentRuntimeProviderDependencies(async () => ({
      doctor: () => {
        calls.push("doctor");
        return { ok: false, status: "missing" };
      },
      repairHeadless: () => {
        calls.push("repair");
        return { ok: false, status: "missing", repaired: false };
      },
      installPackageFromFeed: () => {
        calls.push("install");
        return { ok: true, status: "ready", repaired: true };
      },
    }), {
      env: { VESLO_DOCUMENT_RUNTIME_MODE: "remote-docs-only" },
      now: () => new Date("2026-07-02T12:06:00.000Z"),
      platform: "win32",
    });

    const status = await deps.readStatus!({} as RequestContext);
    const repair = await deps.repair!({} as RequestContext);

    expect(status.status).toBe("remote_only");
    expect(status.repair.available).toBe(false);
    expect(repair.status).toBe("remote_only");
    expect(repair.repair.available).toBe(false);
    expect(calls).toEqual([]);
  });
});
