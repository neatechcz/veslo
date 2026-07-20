import assert from "node:assert/strict";
import test from "node:test";

import {
  createPackagedSmokeEnvironment,
  packagedSmokeBuildArgs,
  packagedSmokePilotArgs,
  resolveCommandInvocation,
  runPackagedSmoke,
} from "./desktop-smoke-packaged.mjs";

test("packaged smoke environment removes development and credential inputs", () => {
  const environment = createPackagedSmokeEnvironment({
    E2E_TAURI_PILOT_BIN: "C:\\tools\\tauri-pilot.exe",
    E2E_OPENCODE_HOME: "C:\\temporary\\opencode",
    VESLO_E2E_CUSTOM_BINARY: "C:\\temporary\\veslo.exe",
    VESLO_DEV_SERVER_URL: "http://127.0.0.1:4096",
    VESLO_DESKTOP_ALLOW_EXTERNAL_RUNTIME_BINARIES: "1",
    VESLO_DOCUMENT_RUNTIME_MODULE: "file:///C:/checkout/provider.mjs",
    VESLO_SIDECAR_DIR: "C:\\checkout\\sidecars",
    VESLO_SERVER_BIN_PATH: "C:\\checkout\\veslo-server.exe",
    OPENCODE_BIN_PATH: "C:\\temporary\\opencode.exe",
    OPENCODE_ROUTER_BIN_PATH: "C:\\checkout\\veslo-code-router.exe",
    OPENAI_API_KEY: "not-for-smoke",
    OPENROUTER_API_KEY: "not-for-smoke",
    DENO_AUTH_TOKENS: "not-for-smoke",
    CUSTOM_API_TOKEN: "not-for-smoke",
    VESLO_DEN_API_BASE: "https://den.example.test",
    VESLO_DEN_AUTH_SNAPSHOT_PATH: "den-auth.json",
    VESLO_AI_GATEWAY_BASE_URL: "https://gateway.example.test",
    VITE_SECRET: "not-for-build",
    PATH: "C:\\Windows",
  });

  assert.equal(environment.E2E_TAURI_PILOT_BIN, "C:\\tools\\tauri-pilot.exe");
  assert.equal(environment.PATH, "C:\\Windows");
  assert.equal(environment.VESLO_PACKAGED_SMOKE, "1");
  assert.equal(environment.VESLO_SIDECAR_FORCE_BUILD, "1");
  assert.equal(environment.E2E_OPENCODE_HOME, undefined);
  assert.equal(environment.VESLO_E2E_CUSTOM_BINARY, undefined);
  assert.equal(environment.VESLO_DEV_SERVER_URL, undefined);
  assert.equal(environment.VESLO_DOCUMENT_RUNTIME_MODULE, undefined);
  assert.equal(environment.VESLO_SIDECAR_DIR, undefined);
  assert.equal(environment.VESLO_SERVER_BIN_PATH, undefined);
  assert.equal(
    environment.VESLO_DESKTOP_ALLOW_EXTERNAL_RUNTIME_BINARIES,
    undefined,
  );
  assert.equal(environment.OPENCODE_BIN_PATH, undefined);
  assert.equal(environment.OPENCODE_ROUTER_BIN_PATH, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.OPENROUTER_API_KEY, undefined);
  assert.equal(environment.DENO_AUTH_TOKENS, undefined);
  assert.equal(environment.CUSTOM_API_TOKEN, undefined);
  assert.equal(environment.VESLO_DEN_API_BASE, undefined);
  assert.equal(environment.VESLO_DEN_AUTH_SNAPSHOT_PATH, undefined);
  assert.equal(environment.VESLO_AI_GATEWAY_BASE_URL, undefined);
  assert.equal(environment.VITE_SECRET, undefined);
});

test("packaged smoke build uses the release and Pilot overlays", () => {
  const args = packagedSmokeBuildArgs();

  assert.deepEqual(packagedSmokePilotArgs(), [
    "--filter",
    "@neatech/veslo-e2e",
    "test:pilot:packaged-smoke",
  ]);
  assert.ok(args.includes("--debug"));
  assert.ok(args.includes("--no-bundle"));
  assert.ok(args.includes("src-tauri/tauri.windows.conf.json"));
  assert.ok(args.includes("src-tauri/tauri.windows.release.conf.json"));
  assert.ok(args.includes("src-tauri/tauri.e2e.conf.json"));
  assert.deepEqual(args.slice(-3), ["--", "--features", "e2e"]);
  assert.equal(args.includes("dev:cleanup"), false);
  assert.equal(args.includes("tauri.dev"), false);
});

test("Windows invokes pnpm through cmd.exe without Node shell mode", () => {
  const invocation = resolveCommandInvocation(
    "pnpm",
    [
      "--filter",
      "@neatech/veslo",
      "exec",
      "tauri",
      "--config",
      "C:\\path with spaces\\config.json",
    ],
    "win32",
  );

  assert.equal(invocation.command.toLowerCase().endsWith("cmd.exe"), true);
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(
    invocation.args[3],
    /^pnpm --filter @neatech\/veslo exec tauri --config "C:\\path with spaces\\config\.json"$/,
  );
});

test("packaged smoke refuses non-Windows hosts", async () => {
  await assert.rejects(
    () => runPackagedSmoke({ platform: "linux" }),
    /Windows only/,
  );
});

test("packaged smoke rebuilds before invoking the dedicated Pilot scenario", async () => {
  const commands = [];

  await runPackagedSmoke({
    platform: "win32",
    environment: { E2E_TAURI_PILOT_BIN: "C:\\tools\\tauri-pilot.exe" },
    run: async (command, args, options) => {
      commands.push({ command, args, options });
    },
  });

  assert.equal(commands.length, 2);
  assert.equal(commands[0].command, "pnpm");
  assert.deepEqual(commands[0].args, packagedSmokeBuildArgs());
  assert.equal(commands[1].command, "pnpm");
  assert.deepEqual(commands[1].args, packagedSmokePilotArgs());
  assert.equal(commands[0].options.env.VESLO_PACKAGED_SMOKE, "1");
  assert.equal(commands[1].options.env.VESLO_SIDECAR_FORCE_BUILD, "1");
});
