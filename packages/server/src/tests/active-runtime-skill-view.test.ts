import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ensureActiveRuntimeSkillView,
  invalidateActiveRuntimeSkillView,
  resetActiveRuntimeSkillViewsForTests,
  setActiveRuntimeSkillViewBeforePublicationForTests,
} from "../active-runtime-skill-view.js";

const roots: string[] = [];

async function workspaceFixture() {
  const path = await mkdtemp(join(process.env.TEMP ?? ".", "veslo-runtime-view-"));
  roots.push(path);
  await mkdir(join(path, ".opencode", "skills", "example"), { recursive: true });
  await writeFile(join(path, ".opencode", "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---\n", "utf8");
  return { id: "workspace-a", name: "Fixture", path, workspaceType: "local" as const };
}

afterEach(async () => {
  resetActiveRuntimeSkillViewsForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("active runtime view reuses a published revision and writes an atomic manifest", async () => {
  const workspace = await workspaceFixture();
  const first = await ensureActiveRuntimeSkillView(workspace);
  const second = await ensureActiveRuntimeSkillView(workspace);

  expect(second.revision).toBe(first.revision);
  expect(second.generatedAt).toBe(first.generatedAt);
  const manifest = JSON.parse(await readFile(join(workspace.path, ".opencode", "veslo.runtime.skills.json"), "utf8"));
  expect(manifest.schemaVersion).toBe(2);
  expect(manifest.revision).toBe(first.revision);
  expect(manifest.entries.map((entry: { name: string }) => entry.name)).toEqual(["example"]);
});

test("explicit invalidation produces a new view after a workspace mutation", async () => {
  const workspace = await workspaceFixture();
  const first = await ensureActiveRuntimeSkillView(workspace);
  await writeFile(join(workspace.path, ".opencode", "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Changed\n---\n", "utf8");
  invalidateActiveRuntimeSkillView(workspace);
  const next = await ensureActiveRuntimeSkillView(workspace);

  expect(next.revision).not.toBe(first.revision);
  expect(next.skills[0]?.description).toBe("Changed");
});

test("force refresh rebuilds the manifest after an out-of-band workspace change", async () => {
  const workspace = await workspaceFixture();
  const first = await ensureActiveRuntimeSkillView(workspace);
  await writeFile(join(workspace.path, ".opencode", "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Force refreshed\n---\n");

  const refreshed = await ensureActiveRuntimeSkillView(workspace, { forceRefresh: true });

  expect(refreshed.revision).not.toBe(first.revision);
  expect(refreshed.skills[0]?.description).toBe("Force refreshed");
});

test("invalidation prevents an older in-flight resolver from publishing over the new view", async () => {
  const workspace = await workspaceFixture();
  let releaseFirstPublication!: () => void;
  const firstPublicationBlocked = new Promise<void>((resolve) => {
    releaseFirstPublication = resolve;
  });
  let publicationCount = 0;
  let signalFirstPublication!: () => void;
  const firstPublicationReached = new Promise<void>((resolve) => {
    signalFirstPublication = resolve;
  });
  setActiveRuntimeSkillViewBeforePublicationForTests(async () => {
    publicationCount += 1;
    if (publicationCount === 1) {
      signalFirstPublication();
      await firstPublicationBlocked;
    }
  });

  const staleFlight = ensureActiveRuntimeSkillView(workspace);
  await firstPublicationReached;
  await writeFile(join(workspace.path, ".opencode", "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Fresh\n---\n", "utf8");
  invalidateActiveRuntimeSkillView(workspace);
  const currentFlight = ensureActiveRuntimeSkillView(workspace);
  releaseFirstPublication();

  const [staleResult, currentResult] = await Promise.all([staleFlight, currentFlight]);
  expect(staleResult.revision).toBe(currentResult.revision);
  expect(currentResult.skills[0]?.description).toBe("Fresh");
  const manifest = JSON.parse(await readFile(join(workspace.path, ".opencode", "veslo.runtime.skills.json"), "utf8"));
  expect(manifest.revision).toBe(currentResult.revision);
});
