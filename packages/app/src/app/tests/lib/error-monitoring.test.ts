import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  captureReportedError,
  initErrorMonitoring,
  type ErrorMonitoringScope,
  resetErrorMonitoringForTests,
  resolveErrorMonitoringConfig,
  setErrorMonitoringClientForTests,
} from "../../lib/error-monitoring.js";
import { reportError } from "../../lib/error-reporter.js";

function createFakeClient() {
  const calls: Array<Record<string, unknown>> = [];
  const scopes: Array<{
    tags: Record<string, string>;
    contexts: Record<string, unknown>;
    level?: string;
  }> = [];

  return {
    calls,
    scopes,
    client: {
      options: undefined as unknown,
      init(options: unknown) {
        this.options = options;
      },
      withScope(callback: (scope: ErrorMonitoringScope) => void) {
        const scope = {
          tags: {} as Record<string, string>,
          contexts: {} as Record<string, unknown>,
          level: undefined as string | undefined,
          setTag(key: string, value: string) {
            scope.tags[key] = value;
          },
          setContext(key: string, value: unknown) {
            scope.contexts[key] = value;
          },
          setLevel(value: string) {
            scope.level = value;
          },
        };
        scopes.push(scope);
        callback(scope);
      },
      captureException(error: unknown) {
        calls.push({ type: "exception", error });
      },
      captureMessage(message: string) {
        calls.push({ type: "message", message });
      },
    },
  };
}

test("error monitoring stays disabled unless a DSN is configured", () => {
  assert.equal(
    resolveErrorMonitoringConfig(
      { PROD: true, VITE_VESLO_GLITCHTIP_DSN: "" },
      { appVersion: "2026.6.2", platform: "desktop" },
    ).enabled,
    false,
  );

  assert.equal(
    resolveErrorMonitoringConfig(
      {
        PROD: true,
        VITE_VESLO_GLITCHTIP_DSN: "https://public@example.com/1",
        VITE_VESLO_GLITCHTIP_ENABLED: "false",
      },
      { appVersion: "2026.6.2", platform: "desktop" },
    ).enabled,
    false,
  );
});

test("error monitoring config normalizes environment, release, and sample rate", () => {
  const config = resolveErrorMonitoringConfig(
    {
      PROD: true,
      VITE_VESLO_GLITCHTIP_DSN: " https://public@example.com/1 ",
      VITE_VESLO_GLITCHTIP_ENVIRONMENT: " production ",
      VITE_VESLO_GLITCHTIP_TRACES_SAMPLE_RATE: "2",
    },
    { appVersion: "2026.6.2", platform: "web" },
  );

  assert.deepEqual(config, {
    enabled: true,
    dsn: "https://public@example.com/1",
    environment: "production",
    release: "veslo@2026.6.2",
    tracesSampleRate: 1,
    platform: "web",
  });
});

test("browser init removes the session integration unsupported by GlitchTip", () => {
  const fake = createFakeClient();

  resetErrorMonitoringForTests();
  initErrorMonitoring(
    {
      PROD: true,
      VITE_VESLO_GLITCHTIP_DSN: "https://public@example.com/1",
    },
    { appVersion: "2026.6.2", platform: "desktop" },
    fake.client,
  );

  const options = fake.client.options as {
    defaultIntegrations?: Array<{ name: string }>;
    sendDefaultPii?: boolean;
  };

  resetErrorMonitoringForTests();

  assert.equal(options.sendDefaultPii, false);
  assert.equal(
    options.defaultIntegrations?.some(integration => integration.name === "BrowserSession"),
    false,
  );
});

test("captured report errors include context tags without user data", () => {
  const fake = createFakeClient();
  const error = new Error("broken");

  captureReportedError(error, "workspace.refresh", "error", fake.client);

  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]?.type, "exception");
  assert.equal(fake.calls[0]?.error, error);
  assert.deepEqual(fake.scopes[0]?.tags, {
    "veslo.context": "workspace.refresh",
    "veslo.severity": "error",
  });
  assert.equal(fake.scopes[0]?.level, "error");
  assert.deepEqual(fake.scopes[0]?.contexts, {
    veslo: {
      context: "workspace.refresh",
      severity: "error",
    },
  });
});

test("reportError forwards to configured monitoring client and preserves console behavior", () => {
  const fake = createFakeClient();
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;

  resetErrorMonitoringForTests();
  setErrorMonitoringClientForTests(fake.client);
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };

  try {
    assert.equal(reportError("plain failure", "startup.audit"), undefined);
  } finally {
    console.warn = originalWarn;
    resetErrorMonitoringForTests();
  }

  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0], {
    type: "message",
    message: "plain failure",
  });
  assert.deepEqual(warnings, [["[startup.audit]", "plain failure"]]);
});

test("desktop shell has native monitoring wiring", () => {
  const cargo = readFileSync(
    fileURLToPath(new URL("../../../../../desktop/src-tauri/Cargo.toml", import.meta.url)),
    "utf8",
  );
  const lib = readFileSync(
    fileURLToPath(new URL("../../../../../desktop/src-tauri/src/lib.rs", import.meta.url)),
    "utf8",
  );
  const monitoring = readFileSync(
    fileURLToPath(new URL("../../../../../desktop/src-tauri/src/error_monitoring.rs", import.meta.url)),
    "utf8",
  );

  assert.match(cargo, /^sentry = /m);
  assert.match(lib, /^mod error_monitoring;/m);
  assert.match(lib, /let _sentry_guard = error_monitoring::init_error_monitoring\(\);/);
  assert.match(monitoring, /VESLO_GLITCHTIP_DSN/);
  assert.match(monitoring, /option_env!\("VESLO_GLITCHTIP_DSN"\)/);
  assert.match(monitoring, /sentry::init/);
  assert.match(monitoring, /send_default_pii: false/);
});
