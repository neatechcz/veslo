import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveCodexCliCommand, resolveCodexCliCommandSpec } from "../src/providers/codex-command.js";

test("resolveCodexCliCommand uses the package-local Codex binary for the default command", () => {
  const resolved = resolveCodexCliCommand("codex");
  const spec = resolveCodexCliCommandSpec("codex");

  if (process.platform === "win32") {
    const entrypoint = path.join(process.cwd(), "node_modules", "@openai", "codex", "bin", "codex.js");
    assert.equal(resolved, process.execPath);
    assert.deepEqual(spec, { command: process.execPath, argsPrefix: [entrypoint] });
    return;
  }

  const binary = path.join(process.cwd(), "node_modules", ".bin", "codex");
  assert.equal(resolved, binary);
  assert.deepEqual(spec, { command: binary, argsPrefix: [] });
});

test("resolveCodexCliCommand keeps explicit custom commands unchanged", () => {
  assert.equal(resolveCodexCliCommand("/opt/codex/bin/codex"), "/opt/codex/bin/codex");
  assert.equal(resolveCodexCliCommand("custom-codex"), "custom-codex");
});
