import assert from "node:assert/strict";
import test from "node:test";

const loadModule = async () => import("../../utils/startup-server-bootstrap.js").catch(() => null);

test("auto bootstrap prefers configured server in cloud-only mode", async () => {
  const mod = await loadModule();
  assert.ok(mod?.shouldAutoBootstrapRemoteServer, "Expected startup server bootstrap helper to exist");

  assert.equal(
    mod.shouldAutoBootstrapRemoteServer({
      cloudOnlyMode: true,
      startupPreference: null,
      hasConfiguredServerUrl: true,
      preferServerByDefault: false,
    }),
    true,
  );
});

test("auto bootstrap prefers configured server when startup preference is server", async () => {
  const mod = await loadModule();
  assert.ok(mod?.shouldAutoBootstrapRemoteServer, "Expected startup server bootstrap helper to exist");

  assert.equal(
    mod.shouldAutoBootstrapRemoteServer({
      cloudOnlyMode: false,
      startupPreference: "server",
      hasConfiguredServerUrl: true,
      preferServerByDefault: false,
    }),
    true,
  );
});

test("auto bootstrap prefers configured server when env-backed dev defaults are present", async () => {
  const mod = await loadModule();
  assert.ok(mod?.shouldAutoBootstrapRemoteServer, "Expected startup server bootstrap helper to exist");

  assert.equal(
    mod.shouldAutoBootstrapRemoteServer({
      cloudOnlyMode: false,
      startupPreference: null,
      hasConfiguredServerUrl: true,
      preferServerByDefault: true,
    }),
    true,
  );
});

test("auto bootstrap still respects an explicit local preference", async () => {
  const mod = await loadModule();
  assert.ok(mod?.shouldAutoBootstrapRemoteServer, "Expected startup server bootstrap helper to exist");

  assert.equal(
    mod.shouldAutoBootstrapRemoteServer({
      cloudOnlyMode: false,
      startupPreference: "local",
      hasConfiguredServerUrl: true,
      preferServerByDefault: true,
    }),
    false,
  );
});
