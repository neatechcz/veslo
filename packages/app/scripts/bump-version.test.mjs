import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const scriptPath = resolve(import.meta.dirname, "./bump-version.mjs");

const writeJson = (filePath, value) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n");
};

test("bump-version keeps orchestrator pinned to veslo-code-router instead of opencode-router", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bump-version-"));

  try {
    writeJson(join(fixtureRoot, "packages/app/package.json"), {
      name: "@neatech/veslo-ui",
      version: "2026.3.1",
    });
    writeJson(join(fixtureRoot, "packages/desktop/package.json"), {
      name: "@neatech/veslo",
      version: "2026.3.1",
      opencodeRouterVersion: "2026.3.1",
    });
    writeJson(join(fixtureRoot, "packages/orchestrator/package.json"), {
      name: "veslo-orchestrator",
      version: "2026.3.1",
      dependencies: {
        "veslo-code-router": "2026.3.1",
        "veslo-server": "2026.3.1",
        "solid-js": "1.9.9",
      },
    });
    writeJson(join(fixtureRoot, "packages/server/package.json"), {
      name: "veslo-server",
      version: "2026.3.1",
    });
    writeJson(join(fixtureRoot, "packages/opencode-router/package.json"), {
      name: "veslo-code-router",
      version: "2026.3.1",
    });
    mkdirSync(join(fixtureRoot, "packages/desktop/src-tauri"), { recursive: true });
    writeFileSync(
      join(fixtureRoot, "packages/desktop/src-tauri/Cargo.toml"),
      [
        "[package]",
        'name = "veslo-desktop"',
        'version = "2026.3.1"',
        "",
      ].join("\n"),
    );
    writeJson(join(fixtureRoot, "packages/desktop/src-tauri/tauri.conf.json"), {
      version: "2026.3.1",
    });

    execFileSync("node", [scriptPath, "--set", "2026.3.2"], {
      cwd: join(fixtureRoot, "packages/app"),
      stdio: "pipe",
    });

    const orchestratorPkg = JSON.parse(
      readFileSync(join(fixtureRoot, "packages/orchestrator/package.json"), "utf8"),
    );

    assert.equal(orchestratorPkg.dependencies["veslo-server"], "2026.3.2");
    assert.equal(orchestratorPkg.dependencies["veslo-code-router"], "2026.3.2");
    assert.equal("opencode-router" in orchestratorPkg.dependencies, false);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
