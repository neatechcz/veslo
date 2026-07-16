import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const rustJob = () => {
  const workflow = read(".github/workflows/quality.yml");
  const start = workflow.indexOf("  rust:\n");
  const end = workflow.indexOf("\n  desktop-recovery:\n", start);
  return workflow.slice(start, end);
};

test("Quality Rust prepares the required sidecars before Cargo checks", () => {
  const job = rustJob();
  const orderedFragments = [
    "uses: oven-sh/setup-bun@v2",
    "name: Install dependencies",
    "name: Prepare desktop sidecars for Rust checks",
    "run: pnpm --filter @neatech/veslo run prepare:sidecar",
    "name: Run Rust quality checks",
    "run: pnpm check:rust",
  ];

  let previousIndex = -1;
  for (const fragment of orderedFragments) {
    const index = job.indexOf(fragment);
    assert.ok(index > previousIndex, `expected Rust job to include ${fragment} in order`);
    previousIndex = index;
  }
});

test("document runtime delegates portable test discovery to Node", () => {
  const packageJson = JSON.parse(read("packages/document-runtime/package.json"));
  assert.equal(packageJson.scripts.test, "node --test");
});

test("Quality requires the headless service gate on Ubuntu and Windows", () => {
  const workflow = read(".github/workflows/quality.yml");
  const packageJson = JSON.parse(read("package.json"));

  assert.match(packageJson.scripts["check:unit"], /pnpm check:services/);
  assert.equal(
    packageJson.scripts["check:services"],
    "pnpm --filter veslo-server build:bin && node --test scripts/headless-services.integration.test.mjs",
  );
  assert.match(workflow, /services-windows:\n\s+name: Quality \/ Services \(Windows\)[\s\S]*?run: pnpm check:services/);
  assert.match(workflow, /needs: \[static, unit, services-windows, rust, desktop-recovery\]/);
  assert.match(workflow, /SERVICES_WINDOWS_RESULT: \$\{\{ needs\.services-windows\.result \}\}/);
});
