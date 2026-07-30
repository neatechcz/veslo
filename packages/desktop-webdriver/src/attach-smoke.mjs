import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

export const LIVE_MODE = "live-dev-webdriver";
const RUNTIME_SCHEMA = "veslo-dev-runtime/v1";
const WEBDRIVER_SCHEMA = "veslo-native-webdriver/v1";

export function fail(message) {
  throw new Error(`[veslo:live-webdriver] ${message}`);
}

function readArgument() {
  const value = process.argv[2]?.trim();
  if (!value) {
    fail("Usage: pnpm test:webdriver:live -- <runtime-info.json>");
  }
  return resolve(value);
}

export function assertSafeClientEnvironment(env = process.env) {
  const unsafeOverrides = [
    "E2E_USE_EXISTING_PROFILE",
    "E2E_OPENCODE_HOME",
    "E2E_MANAGED_AI_GATEWAY_FIXTURE",
    "VESLO_DEN_AUTH_SNAPSHOT_PATH",
    "WEBVIEW2_USER_DATA_FOLDER",
  ].filter((name) => env[name]?.trim());
  if (unsafeOverrides.length > 0) {
    fail(`Refusing to attach with E2E/profile overrides: ${unsafeOverrides.join(", ")}.`);
  }
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(`Cannot read ${label} at ${path}: ${error instanceof Error ? error.message : error}`);
  }
}

function assertLiveRuntime(runtimeInfo) {
  if (runtimeInfo?.schema !== RUNTIME_SCHEMA || runtimeInfo.mode !== LIVE_MODE) {
    fail("Runtime info is not from `pnpm dev:webdriver`.");
  }
  if (runtimeInfo?.profile?.kind !== "existing-development" || runtimeInfo.profile?.isolated !== false) {
    fail("Runtime info does not prove use of the existing development profile.");
  }
  if (runtimeInfo?.env?.VESLO_DEN_AUTH_SNAPSHOT_PATH) {
    fail("Runtime was started with an authentication snapshot override.");
  }
  const descriptorPath = runtimeInfo?.webdriver?.descriptorPath;
  if (typeof descriptorPath !== "string" || !descriptorPath.trim()) {
    fail("Runtime info has no native WebDriver descriptor path.");
  }
  return descriptorPath;
}

function assertNativeDescriptor(descriptor, expectedEndpoint) {
  if (descriptor?.schema !== WEBDRIVER_SCHEMA || descriptor.mode !== LIVE_MODE) {
    fail("Native WebDriver descriptor has an unexpected schema or mode.");
  }
  if (!Number.isInteger(descriptor.appPid) || descriptor.appPid <= 0) {
    fail("Native WebDriver descriptor has no valid app PID.");
  }
  if (descriptor.endpoint !== expectedEndpoint) {
    fail("Native WebDriver descriptor endpoint does not match the launcher descriptor.");
  }
  try {
    process.kill(descriptor.appPid, 0);
  } catch {
    fail(`The recorded Tauri app process (${descriptor.appPid}) is no longer running.`);
  }
}

export function parseLoopbackEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    fail("Native WebDriver endpoint is not a valid URL.");
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    fail("Native WebDriver endpoint must be an explicit 127.0.0.1 HTTP port.");
  }
  const port = Number.parseInt(url.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail("Native WebDriver endpoint has an invalid port.");
  }
  return port;
}

async function assertWebDriverReady(endpoint) {
  let response;
  try {
    response = await fetch(`${endpoint}/status`, { signal: AbortSignal.timeout(3_000) });
  } catch (error) {
    fail(`Native WebDriver endpoint is unavailable: ${error instanceof Error ? error.message : error}`);
  }
  if (!response.ok) {
    fail(`Native WebDriver endpoint returned HTTP ${response.status}.`);
  }
}

export async function connectLiveWebDriver(runtimeInfoPath, { env = process.env } = {}) {
  assertSafeClientEnvironment(env);
  const runtimeInfo = await readJson(runtimeInfoPath, "runtime info");
  const descriptorPath = assertLiveRuntime(runtimeInfo);
  const nativeDescriptorPath = isAbsolute(descriptorPath)
    ? descriptorPath
    : resolve(dirname(runtimeInfoPath), descriptorPath);
  const nativeDescriptor = await readJson(nativeDescriptorPath, "native WebDriver descriptor");
  assertNativeDescriptor(nativeDescriptor, runtimeInfo.webdriver.endpoint);
  const port = parseLoopbackEndpoint(nativeDescriptor.endpoint);
  await assertWebDriverReady(nativeDescriptor.endpoint);
  const browser = await remote({
    logLevel: "silent",
    hostname: "127.0.0.1",
    port,
    capabilities: {
      browserName: "tauri",
      "wdio:tauriServiceOptions": { windowLabel: "main" },
    },
  });
  return { browser, runtimeInfo, nativeDescriptor };
}

async function main() {
  const runtimeInfoPath = readArgument();
  let connection;
  try {
    connection = await connectLiveWebDriver(runtimeInfoPath);
    const { browser, nativeDescriptor } = connection;
    const appRoot = await browser.$("#root");
    await appRoot.waitForExist({ timeout: 10_000 });
    const visible = await appRoot.isDisplayed();
    const windowHandle = await browser.getWindowHandle();
    if (!visible || !windowHandle) {
      fail("The attached Tauri window did not expose a visible application root.");
    }
    console.info(JSON.stringify({
      attached: true,
      mode: LIVE_MODE,
      appPid: nativeDescriptor.appPid,
      appRootVisible: true,
      mutations: false,
    }));
  } finally {
    if (connection?.browser) {
      await connection.browser.deleteSession();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
