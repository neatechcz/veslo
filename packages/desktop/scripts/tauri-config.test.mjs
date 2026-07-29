import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { APP_WINDOW_MIN_WIDTH } from "./window-size-contract.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const tauriConfigPath = resolve(__dirname, "../src-tauri/tauri.conf.json");
const tauriWindowsConfigPath = resolve(
  __dirname,
  "../src-tauri/tauri.windows.conf.json",
);
const srcTauriDir = resolve(__dirname, "../src-tauri");
const runtimePreferencesPath = resolve(
  srcTauriDir,
  "src/runtime_preferences.rs",
);

test("desktop bundle ships the Node runtime beside Chrome DevTools MCP on Windows only", () => {
  const baseConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const windowsConfig = JSON.parse(
    readFileSync(tauriWindowsConfigPath, "utf8"),
  );
  const baseExternalBin = baseConfig?.bundle?.externalBin;
  const windowsExternalBin = windowsConfig?.bundle?.externalBin;
  assert.ok(
    Array.isArray(baseExternalBin),
    "Expected base Tauri externalBin configuration",
  );
  assert.ok(
    Array.isArray(windowsExternalBin),
    "Expected Windows Tauri externalBin configuration",
  );
  assert.ok(baseExternalBin.includes("sidecars/chrome-devtools-mcp"));
  assert.equal(baseExternalBin.includes("sidecars/veslo-node"), false);
  assert.deepEqual(
    windowsExternalBin.filter((entry) => entry !== "sidecars/veslo-node"),
    baseExternalBin,
  );
  assert.ok(windowsExternalBin.includes("sidecars/veslo-node"));
});

test("desktop window keeps Tauri native drag-drop disabled for HTML5 file drop", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const windows = Array.isArray(config?.app?.windows) ? config.app.windows : [];
  assert.ok(windows.length > 0, "Expected at least one desktop window config");

  for (const windowConfig of windows) {
    assert.equal(
      windowConfig?.dragDropEnabled,
      false,
      "Window must set dragDropEnabled=false so Finder file drops reach frontend onDrop handlers",
    );
  }
});

test("desktop window keeps a 390px minimum width for phone-standard layouts", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const windows = Array.isArray(config?.app?.windows) ? config.app.windows : [];
  assert.ok(windows.length > 0, "Expected at least one desktop window config");

  for (const windowConfig of windows) {
    assert.equal(
      windowConfig?.minWidth,
      APP_WINDOW_MIN_WIDTH,
      "Window must keep the documented minimum width so the desktop shell cannot shrink below the phone-standard layout contract",
    );
  }
});

test("desktop runtime preferences default to shared non-sandbox engine on supported desktop platforms", () => {
  const source = readFileSync(runtimePreferencesPath, "utf8");

  assert.match(
    source,
    /fn default_shared_unsandboxed_engine_enabled\(\) -> bool \{\s*cfg!\(any\(windows,\s*target_os = "macos"\)\)\s*\}/,
    "Missing desktop runtime preferences should enable the shared non-sandbox engine on supported desktop platforms",
  );
  assert.doesNotMatch(
    source,
    /fn default_shared_unsandboxed_engine_enabled\(\) -> bool \{\s*false\s*\}/,
    "Desktop runtime preferences must not silently fall back to sandbox-on defaults after the shared engine migration",
  );
});

test("Windows updater MSI installs write a verbose diagnostic log", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const installerArgs = config?.plugins?.updater?.windows?.installerArgs;

  assert.deepEqual(
    installerArgs,
    ["/l*v", "C:\\ProgramData\\veslo-updater-msi.log"],
    "Windows updater should pass verbose MSI logging args so failed in-app updates leave diagnostics",
  );
});

test("Windows MSI embeds the WebView2 bootstrapper for supported fresh installs", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const webviewInstallMode = config?.bundle?.windows?.webviewInstallMode;

  assert.deepEqual(
    webviewInstallMode,
    {
      type: "embedBootstrapper",
    },
    "Windows fresh installs must embed the WebView2 bootstrapper; skip leaves the app unable to run when WebView2 is absent",
  );
});

test("default desktop capability does not expose tauri-pilot", () => {
  const defaultCapability = JSON.parse(
    readFileSync(resolve(srcTauriDir, "capabilities/default.json"), "utf8"),
  );
  const generatedCapabilities = JSON.parse(
    readFileSync(resolve(srcTauriDir, "gen/schemas/capabilities.json"), "utf8"),
  );
  const e2eConfig = JSON.parse(
    readFileSync(resolve(srcTauriDir, "tauri.e2e.conf.json"), "utf8"),
  );
  const defaultPermissions = defaultCapability?.permissions ?? [];
  const generatedDefaultPermissions =
    generatedCapabilities?.["veslo-default"]?.permissions ?? [];
  const e2eCapabilities = e2eConfig?.app?.security?.capabilities ?? [];

  assert.ok(
    !defaultPermissions.includes("pilot:default"),
    "pilot permission must stay out of the release/default capability",
  );
  assert.ok(
    !generatedDefaultPermissions.includes("pilot:default"),
    "generated capability snapshot must not reintroduce pilot into the release/default capability",
  );
  assert.ok(
    JSON.stringify(e2eCapabilities).includes("pilot:default"),
    "E2E config should be the place that enables tauri-pilot automation",
  );
});

test("release capability and runtime exclude the opt-in native WebDriver server", () => {
  const defaultCapability = JSON.parse(
    readFileSync(resolve(srcTauriDir, "capabilities/default.json"), "utf8"),
  );
  const cargoToml = readFileSync(resolve(srcTauriDir, "Cargo.toml"), "utf8");
  const lib = readFileSync(resolve(srcTauriDir, "src/lib.rs"), "utf8");

  assert.equal(
    defaultCapability.permissions.includes("wdio-webdriver:default"),
    false,
    "the release/default capability must never expose native WebDriver",
  );
  assert.match(cargoToml, /webdriver = \["dep:tauri-plugin-wdio-webdriver"\]/);
  assert.match(cargoToml, /tauri-plugin-wdio-webdriver = \{ version = "1\.2\.0", optional = true \}/);
  assert.match(
    lib,
    /#\[cfg\(all\(debug_assertions, feature = "webdriver"\)\)\]\s*let builder = builder\.plugin\(tauri_plugin_wdio_webdriver::init\(\)\);/,
    "the embedded server must be registered only for a debug WebDriver feature build",
  );
  assert.match(lib, /write_live_webdriver_descriptor\(app\)\?;/);
});

test("desktop sandbox environment command mirrors the server backend resolver", () => {
  const lib = readFileSync(resolve(srcTauriDir, "src/lib.rs"), "utf8");
  const misc = readFileSync(
    resolve(srcTauriDir, "src/commands/misc.rs"),
    "utf8",
  );
  const spawn = readFileSync(
    resolve(srcTauriDir, "src/veslo_server/spawn.rs"),
    "utf8",
  );

  assert.match(spawn, /pub fn resolve_server_sandbox_backend\(\) -> String/);
  assert.match(
    misc,
    /pub fn desktop_sandbox_environment\(\) -> DesktopSandboxEnvironment/,
  );
  assert.match(
    misc,
    /crate::veslo_server::spawn::resolve_server_sandbox_backend\(\)/,
  );
  assert.match(lib, /desktop_sandbox_environment/);
});

test("Tauri shutdown records the exit reason around managed service cleanup", () => {
  const lib = readFileSync(resolve(srcTauriDir, "src/lib.rs"), "utf8");

  assert.match(lib, /phase=before-cleanup reason=\{reason\}/);
  assert.match(lib, /phase=after-cleanup reason=\{reason\}/);
  assert.match(lib, /managed_pids=\{pids:\?\}/);
  assert.match(
    lib,
    /stop_managed_services_for_exit\(&app_handle, "exit_requested"\)/,
  );
  assert.match(lib, /stop_managed_services_for_exit\(&app_handle, "exit"\)/);
  assert.match(
    lib,
    /stop_managed_services_for_exit\(&app_handle, "window_close_requested"\)/,
  );
});

test("Windows MSI uses Czech WiX localization", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const language = config?.bundle?.windows?.wix?.language;
  const localePath = "windows/locales/cs-CZ.wxl";
  const localeFilePath = resolve(srcTauriDir, localePath);

  assert.deepEqual(
    language,
    {
      "cs-CZ": {
        localePath,
      },
    },
    "Windows MSI should build the Czech installer instead of the default en-US package",
  );
  assert.ok(
    existsSync(localeFilePath),
    "Expected the Czech WiX locale file to exist",
  );

  const locale = readFileSync(localeFilePath, "utf8");
  assert.match(locale, /Culture="cs-CZ"/);
  assert.match(locale, /<String Id="TauriLanguage">1029<\/String>/);
  assert.match(locale, /<String Id="TauriCodepage">1250<\/String>/);
  assert.match(locale, /Spustit Veslo by Neatech/);
  assert.match(
    locale,
    /Je již nainstalována novější verze aplikace Veslo by Neatech\./,
  );
});

test("Windows installers exclude WSL sandbox payload and hooks", () => {
  const windowsConfigs = [
    tauriConfigPath,
    tauriWindowsConfigPath,
    resolve(srcTauriDir, "tauri.windows.release.conf.json"),
    resolve(srcTauriDir, "tauri.staging.conf.json"),
    resolve(srcTauriDir, "tauri.windows.staging.conf.json"),
  ].map((path) => JSON.parse(readFileSync(path, "utf8")));
  const resources = Object.assign(
    {},
    ...windowsConfigs.map((config) => config.bundle?.resources ?? {}),
  );
  const wixEntries = windowsConfigs.flatMap((entry) => {
    const wix = entry.bundle?.windows?.wix ?? {};
    return [...(wix.fragmentPaths ?? []), ...(wix.componentGroupRefs ?? [])];
  });
  const nsisHooks = windowsConfigs.map(
    (entry) => entry.bundle?.windows?.nsis?.installerHooks,
  );
  const hasWslPayload = Object.entries(resources).some(([source, destination]) =>
    /(?:wsl2-|windows-wsl2-|veslosandbox)/i.test(`${source}\n${destination}`),
  );

  assert.equal(hasWslPayload, false);
  assert.equal(
    wixEntries.some((entry) => /(?:wsl|sandbox)/i.test(entry)),
    false,
  );
  assert.equal(
    nsisHooks.some((entry) => /(?:wsl|sandbox)/i.test(entry ?? "")),
    false,
  );
});

test("Windows NSIS stays current-user without a WSL setup hook", () => {
  const config = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
  const nsis = config?.bundle?.windows?.nsis ?? {};

  assert.equal(nsis.installMode, "currentUser");
  assert.deepEqual(nsis.languages, ["Czech", "English"]);
  assert.deepEqual(nsis.customLanguageFiles, {
    Czech: "windows/locales/Czech.nsh",
  });
  assert.equal(nsis.installerHooks, undefined);
});

test("Windows runtime process launches stay hidden", () => {
  const supervisedProcess = readFileSync(
    resolve(srcTauriDir, "src/supervised_process.rs"),
    "utf8",
  );
  const windowsPlatform = readFileSync(
    resolve(srcTauriDir, "src/platform/windows.rs"),
    "utf8",
  );

  assert.match(
    supervisedProcess,
    /const\s+CREATE_NO_WINDOW:\s*u32\s*=\s*0x0800_0000/,
  );
  assert.match(
    supervisedProcess,
    /command\.creation_flags\(CREATE_NO_WINDOW\)/,
  );
  assert.match(
    supervisedProcess,
    /pub fn spawn\(self\)[\s\S]*?spawn_hidden_command/,
    "Windows supervised sidecars should route through the hidden native spawn wrapper",
  );
  assert.match(
    windowsPlatform,
    /const\s+CREATE_NO_WINDOW:\s*u32\s*=\s*0x08000000/,
  );
  assert.match(
    windowsPlatform,
    /pub fn configure_hidden[\s\S]*?command\.creation_flags\(CREATE_NO_WINDOW\)/,
  );
});
