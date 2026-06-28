import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveCodexCliCommand } from "../src/providers/codex-command.js";

test("resolveCodexCliCommand uses the package-local Codex binary for the default command", () => {
  const resolved = resolveCodexCliCommand("codex");

  assert.equal(resolved, path.join(process.cwd(), "node_modules", ".bin", "codex"));
});

test("resolveCodexCliCommand keeps explicit custom commands unchanged", () => {
  assert.equal(resolveCodexCliCommand("/opt/codex/bin/codex"), "/opt/codex/bin/codex");
  assert.equal(resolveCodexCliCommand("custom-codex"), "custom-codex");
});
