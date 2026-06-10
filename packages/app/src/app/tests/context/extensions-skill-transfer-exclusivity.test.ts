import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import type { LocalSkillCard, LocalSkillListScope, WorkspaceInfo } from "../../lib/tauri";
import type { SkillMutationTarget } from "../../lib/skill-inventory";

const { createExtensionsStore } = await import("../../context/extensions.js");

type InvokeCall = {
  command: string;
  args: Record<string, unknown>;
};

type SkillFileSystem = {
  files: Map<string, string>;
  calls: InvokeCall[];
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  listLocalSkillsScoped: (projectDir: string, scope: LocalSkillListScope) => Promise<LocalSkillCard[]>;
};

const globalSkillPath = (name: string) => `/Users/example/.opencode/skills/${name}/SKILL.md`;
const workspaceSkillPath = (workspaceRoot: string, name: string) => `${workspaceRoot}/.opencode/skills/${name}/SKILL.md`;

const localSkillCardsForRoot = (files: Map<string, string>, root: string): LocalSkillCard[] => {
  const skillRoot = root.endsWith("/") ? `${root}.opencode/skills/` : `${root}/.opencode/skills/`;
  return Array.from(files.keys())
    .filter((path) => path.startsWith(skillRoot) && path.endsWith("/SKILL.md"))
    .map((path) => {
      const name = path.slice(skillRoot.length).replace(/\/SKILL\.md$/, "");
      return { name, path };
    });
};

const createSkillFileSystem = (seed: Record<string, string>): SkillFileSystem => {
  const files = new Map(Object.entries(seed));
  const calls: InvokeCall[] = [];

  const invoke = async (command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command === "read_local_skill_at_path") {
      const path = String(args.path ?? "");
      const content = files.get(path);
      if (content == null) throw new Error("Skill not found");
      return { path, content };
    }
    if (command === "install_skill_template") {
      const projectDir = String(args.projectDir ?? "");
      const name = String(args.name ?? "");
      const path = workspaceSkillPath(projectDir, name);
      if (files.has(path) && args.overwrite !== true) {
        return { ok: false, status: 1, stdout: "", stderr: `Skill already exists at ${path}` };
      }
      files.set(path, String(args.content ?? ""));
      return { ok: true, status: 0, stdout: `Installed skill to ${path.replace(/\/SKILL\.md$/, "")}`, stderr: "" };
    }
    if (command === "install_global_skill_template") {
      const name = String(args.name ?? "");
      const path = globalSkillPath(name);
      if (files.has(path) && args.overwrite !== true) {
        return { ok: false, status: 1, stdout: "", stderr: `Skill already exists at ${path}` };
      }
      files.set(path, String(args.content ?? ""));
      return { ok: true, status: 0, stdout: `Installed skill to ${path.replace(/\/SKILL\.md$/, "")}`, stderr: "" };
    }
    if (command === "uninstall_skill_at_path") {
      const path = String(args.path ?? "");
      if (!files.has(path)) {
        return { ok: false, status: 1, stdout: "", stderr: "Skill not found" };
      }
      files.delete(path);
      return { ok: true, status: 0, stdout: `Removed skill ${String(args.name ?? "")}`, stderr: "" };
    }
    if (command === "list_local_skills") {
      return localSkillCardsForRoot(files, String(args.projectDir ?? ""));
    }
    throw new Error(`Unexpected Tauri command: ${command}`);
  };

  return {
    files,
    calls,
    invoke,
    async listLocalSkillsScoped(projectDir, scope) {
      if (scope === "global") {
        const globalRoot = "/Users/example";
        return localSkillCardsForRoot(files, globalRoot);
      }
      return localSkillCardsForRoot(files, projectDir);
    },
  };
};

async function withMockTauriRuntime(run: (fs: SkillFileSystem) => Promise<void>, seed: Record<string, string>) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const fs = createSkillFileSystem(seed);
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: fs.invoke,
      },
      location: {
        hostname: "tauri.localhost",
      },
      localStorage: createMemoryStorage(),
      sessionStorage: createMemoryStorage(),
    },
  });

  try {
    await run(fs);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }
}

function createMemoryStorage(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
    getItem(key: string) {
      return entries.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(entries.keys())[index] ?? null;
    },
    removeItem(key: string) {
      entries.delete(key);
    },
    setItem(key: string, value: string) {
      entries.set(key, value);
    },
  };
}

const workspaceRoot = "/workspaces/alpha";
const workspaces: WorkspaceInfo[] = [{
  id: "ws-alpha",
  name: "Alpha",
  path: workspaceRoot,
  preset: "starter",
  workspaceType: "local",
}];

function createStore(fs: SkillFileSystem) {
  return createExtensionsStore({
    client: () => null,
    projectDir: () => workspaceRoot,
    activeWorkspaceId: () => "ws-alpha",
    activeWorkspaceRoot: () => workspaceRoot,
    workspaceType: () => "local",
    workspaces: () => workspaces,
    vesloServerClient: () => null,
    vesloServerStatus: () => "disconnected",
    vesloServerCapabilities: () => null,
    vesloServerWorkspaceId: () => null,
    listLocalSkillsScoped: fs.listLocalSkillsScoped,
    setBusy: () => undefined,
    setBusyLabel: () => undefined,
    setBusyStartedAt: () => undefined,
    setError: () => undefined,
    markReloadRequired: () => undefined,
  });
}

test("copySkillInstanceToWorkspace retargets a user skill by removing the global source", async () => {
  const name = "Research";
  const sourcePath = globalSkillPath(name);
  const targetPath = workspaceSkillPath(workspaceRoot, name);

  await withMockTauriRuntime(async (fs) => {
    await createRoot(async (dispose) => {
      try {
        const store = createStore(fs);
        const target: SkillMutationTarget = {
          name,
          path: sourcePath,
          scope: "user-global",
        };

        const result = await store.copySkillInstanceToWorkspace(target, "ws-alpha");

        assert.equal(result.ok, true);
        assert.equal(fs.files.get(targetPath), "# Research\n");
        assert.equal(fs.files.has(sourcePath), false);
        assert.equal(
          fs.calls.some((call) => call.command === "uninstall_skill_at_path" && call.args.path === sourcePath),
          true,
        );
      } finally {
        dispose();
      }
    });
  }, {
    [sourcePath]: "# Research\n",
  });
});

test("copySkillInstanceToGlobal retargets a workspace skill even when the caller requests a copy", async () => {
  const name = "Research";
  const sourcePath = workspaceSkillPath(workspaceRoot, name);
  const targetPath = globalSkillPath(name);

  await withMockTauriRuntime(async (fs) => {
    await createRoot(async (dispose) => {
      try {
        const store = createStore(fs);
        const target: SkillMutationTarget = {
          name,
          path: sourcePath,
          scope: "workspace",
          workspaceId: "ws-alpha",
        };

        const result = await store.copySkillInstanceToGlobal(target, { deleteSource: false });

        assert.equal(result.ok, true);
        assert.equal(fs.files.get(targetPath), "# Research\n");
        assert.equal(fs.files.has(sourcePath), false);
        assert.equal(
          fs.calls.some((call) => call.command === "uninstall_skill_at_path" && call.args.path === sourcePath),
          true,
        );
      } finally {
        dispose();
      }
    });
  }, {
    [sourcePath]: "# Research\n",
  });
});
