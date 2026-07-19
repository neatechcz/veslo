import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import cs from "../../i18n/locales/cs.js";
import en from "../../i18n/locales/en.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("reload banner copy is localized and no longer calls generic config changes OpenCode changes", () => {
  const systemStateSource = readFileSync(resolve(__dirname, "../system-state.ts"), "utf8");
  const sessionSource = readFileSync(resolve(__dirname, "../pages/session.tsx"), "utf8");
  const configSource = readFileSync(resolve(__dirname, "../pages/config.tsx"), "utf8");
  const managedAiBannerSource = readFileSync(
    resolve(__dirname, "../components/session/managed-ai-server-reload-banner.tsx"),
    "utf8",
  );

  for (const key of [
    "reload.banner_default_description",
    "reload.banner_config_description",
    "reload.engine_button",
    "reload.toast_blocked_workspace",
    "reload.toast_warning_active",
    "reload.toast_reload",
    "reload.toast_reload_stopped",
    "reload.toast_reloading",
    "reload.toast_dismiss",
    "managed_ai.runtime_config_pending_reload",
    "managed_ai.runtime_config_reloading",
  ]) {
    assert.ok(key in en, `missing English reload translation: ${key}`);
    assert.ok(key in cs, `missing Czech reload translation: ${key}`);
  }

  assert.equal(
    en["reload.banner_config_description"],
    "Veslo detected configuration changes. Reload the engine to apply them."
  );
  assert.equal(systemStateSource.includes("Veslo detected OpenCode configuration changes"), false);
  assert.equal(systemStateSource.includes("Veslo detected configuration changes. Reload the engine to apply them."), false);

  assert.match(systemStateSource, /body:\s*t\(bodyKey,\s*currentLocale\(\)\)/);
  assert.match(systemStateSource, /copy\("reload\.banner_config_description"\)/);
  assert.match(systemStateSource, /copy\("reload\.banner_default_description"\)/);
  assert.match(sessionSource, /formatTr\("reload\.toast_warning_active"/);
  assert.match(sessionSource, /tr\("reload\.toast_reload_stopped"\)/);
  assert.match(sessionSource, /tr\("reload\.toast_reloading"\)/);
  assert.match(sessionSource, /ManagedAiServerReloadBanner/);
  assert.match(managedAiBannerSource, /session-managed-ai-config-status/);
  assert.match(sessionSource, /managed_ai\.runtime_config_pending_reload/);
  assert.match(sessionSource, /managed_ai\.runtime_config_reloading/);
  assert.match(sessionSource, /tr\("reload\.toast_dismiss"\)/);
  assert.match(configSource, /tr\("reload\.toast_reloading"\)/);
  assert.match(configSource, /tr\("reload\.engine_button"\)/);
  assert.match(configSource, /tr\("reload\.toast_blocked_connect"\)/);
  assert.match(configSource, /tr\("reload\.toast_blocked_workspace"\)/);

  for (const hardcodedCopy of [
    "Reloading stops ",
    "Reload & Stop Tasks",
    "Reloading...",
    ">Reload<",
    ">Later<",
    "Reload engine",
    "Connect to this worker to reload.",
    "Reloading is only available for local workers or connected Veslo servers.",
  ]) {
    assert.equal(
      `${sessionSource}\n${configSource}`.includes(hardcodedCopy),
      false,
      `unexpected hardcoded reload copy: ${hardcodedCopy}`
    );
  }
});
