import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { ReloadEventStore } from "../events.js";
import { startReloadWatchers } from "../reload-watcher.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

test("reload watcher observes every supported direct workspace skill root", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-reload-watcher-"));
  roots.push(workspaceRoot);
  const events = new ReloadEventStore();
  const observedPaths: string[] = [];
  const watcher = startReloadWatchers({
    config: {
      workspaces: [{
        id: "ws_1",
        name: "Workspace",
        path: workspaceRoot,
        workspaceType: "local",
      }],
    } as any,
    reloadEvents: events,
    debounceMs: 1,
    onReloadHint: (_workspace, _reason, trigger) => {
      if (trigger?.path) observedPaths.push(resolve(trigger.path));
    },
  });

  try {
    for (const root of [".opencode", ".claude", ".agents", ".agent"]) {
      const cursor = events.cursor();
      const skillPath = join(workspaceRoot, root, "skills", `from-${root.slice(1)}`, "SKILL.md");
      const expectedRoot = resolve(workspaceRoot, root);
      await mkdir(join(skillPath, ".."), { recursive: true });
      await writeFile(skillPath, "---\nname: test\ndescription: test\n---\n", "utf8");
      await waitFor(
        () => events.list("ws_1", cursor).some((event) => {
          const eventPath = event.trigger?.path ? resolve(event.trigger.path) : "";
          return event.reason === "skills" &&
            (eventPath === expectedRoot || eventPath.startsWith(`${expectedRoot}${sep}`));
        }),
        `expected a skills reload event for ${root}`,
      );
      expect(observedPaths.some((path) =>
        path === expectedRoot || path.startsWith(`${expectedRoot}${sep}`)
      )).toBe(true);
    }
  } finally {
    watcher.close();
  }
});
