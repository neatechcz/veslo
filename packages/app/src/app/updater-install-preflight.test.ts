import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const systemStateSource = readFileSync(new URL("./system-state.ts", import.meta.url), "utf8");
const tauriSource = readFileSync(new URL("./lib/tauri.ts", import.meta.url), "utf8");

test("update install flow prepares desktop services before launching installer", () => {
  assert.match(tauriSource, /export async function updaterPrepareInstall\(\): Promise<void>/);
  assert.match(tauriSource, /invoke<void>\("updater_prepare_install"\)/);
  assert.match(systemStateSource, /import \{[\s\S]*updaterPrepareInstall[\s\S]*\} from "\.\/lib\/tauri";/);
  assert.match(
    systemStateSource,
    /await updaterPrepareInstall\(\);[\s\S]*await pending\.update\.install\(\);/,
    "installer handoff should happen only after desktop services are stopped",
  );
});
