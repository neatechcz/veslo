import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const listSource = readFileSync(new URL("../src/app/components/session/workspace-session-list.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../src/app/pages/session.tsx", import.meta.url), "utf8");
const composerSource = readFileSync(new URL("../src/app/components/session/composer.tsx", import.meta.url), "utf8");

assert.equal(
  listSource.includes("New session"),
  true,
  "workspace list must expose the new session primary action",
);

assert.equal(
  sessionSource.includes("Start a new session"),
  true,
  "session empty state must use session-first copy",
);

assert.equal(
  sessionSource.includes("Choose folder"),
  true,
  "session actions must expose choose-folder copy-and-switch flow",
);

assert.equal(
  composerSource.includes("canChooseSessionFolder"),
  true,
  "composer must accept choose-folder state for private workspace sessions",
);

assert.equal(
  composerSource.includes("onChooseSessionFolder"),
  true,
  "composer must accept choose-folder action handler",
);

assert.equal(
  composerSource.includes("Choose folder"),
  true,
  "composer must expose choose-folder action next to the prompt for private workspaces",
);

assert.equal(
  sessionSource.includes("Create or connect a worker"),
  false,
  "session header must not use worker-first copy",
);

assert.equal(
  sessionSource.includes("Connect your worker"),
  false,
  "session empty state must not ask the user to connect a worker",
);

assert.equal(
  sessionSource.includes("Create worker on this device"),
  false,
  "session empty state must not offer local worker creation",
);

assert.equal(
  sessionSource.includes("Connect remote worker"),
  false,
  "session empty state must not expose remote worker connect in the default UI",
);

console.log(JSON.stringify({ ok: true, checks: 10 }));
