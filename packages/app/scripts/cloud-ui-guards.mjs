import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const settingsSource = readFileSync(new URL("../src/app/pages/settings.tsx", import.meta.url), "utf8");
assert.equal(
  settingsSource.includes("Start local server"),
  false,
  "settings must not expose local start action text",
);
assert.equal(
  settingsSource.includes("props.startupPreference === \"local\""),
  false,
  "settings must not branch on local startup preference",
);
assert.equal(
  settingsSource.includes("Select a local workspace before revealing config."),
  false,
  "settings must not prompt for local workspace selection",
);
assert.equal(
  settingsSource.includes("No active local workspace."),
  false,
  "settings must not display local workspace placeholders",
);

const statusBarSource = readFileSync(
  new URL("../src/app/components/status-bar.tsx", import.meta.url),
  "utf8",
);
assert.equal(
  statusBarSource.includes("Local Server"),
  false,
  "status bar must not display local server label",
);

const sessionSource = readFileSync(new URL("../src/app/pages/session.tsx", import.meta.url), "utf8");
assert.equal(
  sessionSource.includes("Veslo needs a local or remote worker before you can start a session."),
  false,
  "session empty state must not mention local workers",
);
assert.equal(
  sessionSource.includes("Create local worker"),
  false,
  "session empty state must not offer local worker creation",
);
assert.equal(
  sessionSource.includes("Set up your first worker"),
  false,
  "session empty state title must not imply local setup",
);
assert.equal(
  sessionSource.includes("CLOUD_ONLY_MODE"),
  true,
  "session empty state must gate cloud-only behavior",
);

console.log(JSON.stringify({ ok: true, checks: 9 }));
