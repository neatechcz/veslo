import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const testDir = join(process.cwd(), "test");
const unitTests = readdirSync(testDir)
  .filter((name) => name.endsWith(".test.js"))
  .filter((name) => !name.startsWith("bridge-"))
  .sort()
  .map((name) => join("test", name));

if (unitTests.length === 0) {
  console.error("No router unit tests found.");
  process.exit(1);
}

const result = spawnSync("bun", ["test", ...unitTests], {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
