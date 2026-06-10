import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../../components/desktop-context-menu.tsx", import.meta.url), "utf8");
const tauriConfig = JSON.parse(
  readFileSync(new URL("../../../../../desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"),
) as {
  app?: {
    windows?: Array<{
      title?: string;
      devtools?: boolean;
    }>;
  };
};
const tauriCapability = JSON.parse(
  readFileSync(new URL("../../../../../desktop/src-tauri/capabilities/default.json", import.meta.url), "utf8"),
) as {
  permissions?: unknown[];
};
const tauriCargoToml = readFileSync(
  new URL("../../../../../desktop/src-tauri/Cargo.toml", import.meta.url),
  "utf8",
);

test("desktop context menu lets native right-click open when no text is selected", () => {
  const handler = source.match(/const\s+handleContextMenu\s*=\s*\(event:\s*MouseEvent\)\s*=>\s*\{(?<body>[\s\S]*?)\n\s*\};/);
  assert.ok(handler?.groups?.body, "expected context menu handler");
  assert.equal(
    handler.groups.body.indexOf("event.preventDefault()") > handler.groups.body.indexOf("selectedTextForTarget"),
    true,
    "handler must inspect selected text before suppressing the native context menu",
  );

  const noSelectionBranch = handler.groups.body.match(/if\s*\(text\.length\s*===\s*0\)\s*\{(?<body>[\s\S]*?)\n\s*\}/);
  assert.ok(noSelectionBranch?.groups?.body, "expected explicit no-selection branch");
  assert.doesNotMatch(
    noSelectionBranch.groups.body,
    /preventDefault\s*\(/,
    "no-selection right-click must not suppress the native webview context menu",
  );
});

test("main Tauri window enables devtools for manual runtime debugging", () => {
  const mainWindow = tauriConfig.app?.windows?.[0];
  assert.equal(mainWindow?.devtools, true);
  assert.ok(
    tauriCapability.permissions?.includes("core:webview:allow-internal-toggle-devtools"),
    "default capability should allow toggling webview devtools",
  );
  assert.equal(
    tauriCapability.permissions?.includes("core:webview:deny-internal-toggle-devtools"),
    false,
    "default capability must not explicitly deny devtools",
  );

  const tauriDependency = tauriCargoToml.match(/^tauri\s*=\s*\{(?<body>[^\n]+)\}/m);
  assert.ok(tauriDependency?.groups?.body, "expected tauri dependency declaration");
  assert.match(
    tauriDependency.groups.body,
    /features\s*=\s*\[[^\]]*"devtools"/,
    "release builds must compile tauri with the devtools feature",
  );
});
