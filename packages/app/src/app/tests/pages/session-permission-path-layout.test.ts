import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../pages/session.tsx"), "utf8");

test("permission scope row allows long paths to wrap", () => {
  assert.match(
    source,
    /<div class="[^"]*break-all[^"]*">\s*<HardDrive size=\{12\} \/>\s*\{props\.activePermission\?\.patterns\.join\(", "\)\}/,
    "permission scope row should wrap long directory patterns instead of clipping them",
  );
});
