import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { readJsoncFile } from "../jsonc.js";
import type { MaterializablePluginPolicy } from "../plugin-materializer.js";
import { materializePluginPolicies } from "../plugin-materializer.js";
import { listPlugins } from "../plugins.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("plugin materializer", () => {
  test("materializes enabled project config-spec policies and marks listPlugins entries as managed", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    await writeFile(
      join(workspaceRoot, "opencode.jsonc"),
      JSON.stringify({ plugin: ["unmanaged-package"] }, null, 2),
      "utf8",
    );

    const policy = policyFor({
      id: "platform.project-config",
      spec: "managed-project-plugin@git+https://example.com/project.git",
      target: "project",
    });

    const result = await materializePluginPolicies({ workspaceRoot, dataDir, policies: [policy] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected materialization success");
    expect(result.conflicts).toEqual([]);
    expect(result.project.config.addedSpecs).toEqual([policy.spec]);

    const { data: config } = await readJsoncFile<Record<string, unknown>>(join(workspaceRoot, "opencode.jsonc"), {});
    expect(config.plugin).toEqual(["unmanaged-package", policy.spec]);

    const manifest = await readJson(join(workspaceRoot, ".opencode", "veslo", "plugins", "managed-plugin-specs.json"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      managedBy: "veslo-plugin-materializer",
      target: "project",
      entries: [
        {
          policyId: policy.id,
          spec: policy.spec,
          target: "project",
        },
      ],
    });

    const plugins = await listPlugins(workspaceRoot, false);
    expect(plugins.items).toContainEqual(expect.objectContaining({
      spec: "unmanaged-package",
      managed: false,
    }));
    expect(plugins.items).toContainEqual(expect.objectContaining({
      spec: policy.spec,
      managed: true,
      policyId: policy.id,
      displayName: policy.displayName,
    }));
  });

  test("materializes enabled user config-spec policies into user OpenCode config and Veslo data manifest", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const userOpencodeConfigDir = await tempDir("veslo-plugin-materializer-user-config-");
    await writeFile(
      join(userOpencodeConfigDir, "opencode.jsonc"),
      JSON.stringify({ plugin: ["unmanaged-global"] }, null, 2),
      "utf8",
    );

    const policy = policyFor({
      id: "platform.user-config",
      spec: "managed-user-plugin",
      target: "user",
    });

    const result = await materializePluginPolicies({ workspaceRoot, dataDir, userOpencodeConfigDir, policies: [policy] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected materialization success");
    expect(result.user.config.addedSpecs).toEqual([policy.spec]);

    const { data: config } = await readJsoncFile<Record<string, unknown>>(join(userOpencodeConfigDir, "opencode.jsonc"), {});
    expect(config.plugin).toEqual(["unmanaged-global", policy.spec]);

    const manifest = await readJson(join(dataDir, "plugins", "managed-plugin-specs.json"));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      managedBy: "veslo-plugin-materializer",
      target: "user",
      entries: [
        {
          policyId: policy.id,
          spec: policy.spec,
          target: "user",
        },
      ],
    });
  });

  test("writes managed file plugin roots with a root manifest and per-plugin marker", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const policy = policyFor({
      id: "platform.file-plugin",
      spec: "file-plugin",
      target: "project",
      files: [
        {
          path: "plugin.js",
          content: "export const Plugin = () => ({ name: 'managed' });\n",
        },
      ],
    });

    const result = await materializePluginPolicies({ workspaceRoot, dataDir, policies: [policy] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected materialization success");
    const rootDir = join(workspaceRoot, ".opencode", "plugins", "veslo-managed");
    const rootManifest = await readJson(join(rootDir, ".veslo-plugin-materialization.json")) as {
      entries: Array<{ pluginDir: string }>;
    };
    expect(rootManifest).toMatchObject({
      schemaVersion: 1,
      managedBy: "veslo-plugin-materializer",
      target: "project",
      entries: [
        {
          policyId: policy.id,
          spec: policy.spec,
          target: "project",
        },
      ],
    });

    const entry = rootManifest.entries[0];
    expect(await readFile(join(entry.pluginDir, "plugin.js"), "utf8")).toBe(policy.files?.[0]?.content ?? "");
    expect(await readJson(join(entry.pluginDir, ".veslo-managed-plugin.json"))).toMatchObject({
      schemaVersion: 1,
      managedBy: "veslo-plugin-materializer",
      policyId: policy.id,
      spec: policy.spec,
    });

    const plugins = await listPlugins(workspaceRoot, false);
    expect(plugins.items).toContainEqual(expect.objectContaining({
      spec: `file://${join(entry.pluginDir, "plugin.js")}`,
      managed: true,
      policyId: policy.id,
    }));
  });

  test("removes stale managed config specs while leaving unmanaged OpenCode plugin entries untouched", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    await writeFile(
      join(workspaceRoot, "opencode.jsonc"),
      JSON.stringify({ plugin: ["unmanaged-before", "unmanaged-after"] }, null, 2),
      "utf8",
    );

    const stale = policyFor({ id: "platform.stale-config", spec: "stale-managed", target: "project" });
    await materializePluginPolicies({ workspaceRoot, dataDir, policies: [stale] });

    const next = policyFor({ id: "platform.next-config", spec: "next-managed", target: "project" });
    const result = await materializePluginPolicies({ workspaceRoot, dataDir, policies: [next] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected materialization success");
    expect(result.project.config.removedSpecs).toEqual(["stale-managed"]);

    const { data: config } = await readJsoncFile<Record<string, unknown>>(join(workspaceRoot, "opencode.jsonc"), {});
    expect(config.plugin).toEqual(["unmanaged-before", "unmanaged-after", "next-managed"]);

    const manifest = await readJson(join(workspaceRoot, ".opencode", "veslo", "plugins", "managed-plugin-specs.json"));
    expect(manifest.entries).toMatchObject([
      {
        policyId: next.id,
        spec: next.spec,
      },
    ]);
  });

  test("updates managed config specs by removing the exact old spec and adding the desired spec", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const first = policyFor({ id: "platform.versioned-config", spec: "foo@1.0.0", target: "project" });
    await materializePluginPolicies({ workspaceRoot, dataDir, policies: [first] });

    const next = policyFor({ id: first.id, spec: "foo@2.0.0", target: "project" });
    const result = await materializePluginPolicies({ workspaceRoot, dataDir, policies: [next] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected materialization success");
    expect(result.project.config.removedSpecs).toEqual(["foo@1.0.0"]);
    expect(result.project.config.addedSpecs).toEqual(["foo@2.0.0"]);

    const { data: config } = await readJsoncFile<Record<string, unknown>>(join(workspaceRoot, "opencode.jsonc"), {});
    expect(config.plugin).toEqual(["foo@2.0.0"]);

    const manifest = await readJson(join(workspaceRoot, ".opencode", "veslo", "plugins", "managed-plugin-specs.json"));
    expect(manifest.entries).toMatchObject([
      {
        policyId: next.id,
        spec: "foo@2.0.0",
      },
    ]);
  });

  test("reports conflict when a normalized matching config spec lacks exact Veslo ownership proof", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const first = policyFor({ id: "platform.versioned-config", spec: "foo@1.0.0", target: "project" });
    await materializePluginPolicies({ workspaceRoot, dataDir, policies: [first] });
    await writeFile(
      join(workspaceRoot, "opencode.jsonc"),
      JSON.stringify({ plugin: ["foo@9.9.9"] }, null, 2),
      "utf8",
    );

    const next = policyFor({ id: first.id, spec: "foo@2.0.0", target: "project" });
    const result = await materializePluginPolicies({ workspaceRoot, dataDir, policies: [next] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected materialization conflict");
    expect(result.conflicts).toContainEqual(expect.objectContaining({
      code: "unmanaged_config_spec_conflict",
      policyId: next.id,
      spec: "foo@2.0.0",
      target: "project",
    }));

    const { data: config } = await readJsoncFile<Record<string, unknown>>(join(workspaceRoot, "opencode.jsonc"), {});
    expect(config.plugin).toEqual(["foo@9.9.9"]);
  });

  test("removes stale managed file plugins only when the previous entry still carries Veslo markers", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const stale = policyFor({
      id: "platform.stale-file",
      spec: "stale-file",
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'stale';\n" }],
    });
    await materializePluginPolicies({ workspaceRoot, dataDir, policies: [stale] });

    const rootDir = join(workspaceRoot, ".opencode", "plugins", "veslo-managed");
    const firstManifest = await readJson(join(rootDir, ".veslo-plugin-materialization.json")) as {
      entries: Array<{ pluginDir: string }>;
    };
    const staleDir = firstManifest.entries[0]?.pluginDir ?? "";
    await writeFile(join(rootDir, "manual.js"), "export const name = 'manual';\n", "utf8");

    const next = policyFor({
      id: "platform.next-file",
      spec: "next-file",
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'next';\n" }],
    });
    const result = await materializePluginPolicies({ workspaceRoot, dataDir, policies: [next] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected materialization success");
    expect(result.project.files.removedPolicyIds).toEqual(["platform.stale-file"]);
    await expect(stat(staleDir)).rejects.toThrow();
    expect(await readFile(join(rootDir, "manual.js"), "utf8")).toContain("manual");
  });

  test("removes only stale manifest-listed plugin files and preserves unlisted files in the managed directory", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const stale = policyFor({
      id: "platform.stale-file-with-extra",
      spec: "stale-file-with-extra",
      target: "project",
      files: [
        { path: "plugin.js", content: "export const name = 'stale';\n" },
        { path: "nested/helper.js", content: "export const helper = true;\n" },
      ],
    });
    await materializePluginPolicies({ workspaceRoot, dataDir, policies: [stale] });

    const rootDir = join(workspaceRoot, ".opencode", "plugins", "veslo-managed");
    const firstManifest = await readJson(join(rootDir, ".veslo-plugin-materialization.json")) as {
      entries: Array<{ pluginDir: string }>;
    };
    const staleDir = firstManifest.entries[0]?.pluginDir ?? "";
    await writeFile(join(staleDir, "local-note.txt"), "keep me\n", "utf8");

    const next = policyFor({
      id: "platform.next-file",
      spec: "next-file",
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'next';\n" }],
    });
    const result = await materializePluginPolicies({ workspaceRoot, dataDir, policies: [next] });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected materialization success");
    expect(result.project.files.removedPolicyIds).toEqual(["platform.stale-file-with-extra"]);
    expect(await readFile(join(staleDir, "local-note.txt"), "utf8")).toBe("keep me\n");
    await expect(readFile(join(staleDir, "plugin.js"), "utf8")).rejects.toThrow();
    await expect(readFile(join(staleDir, "nested", "helper.js"), "utf8")).rejects.toThrow();
    expect(await readdir(staleDir)).toEqual(["local-note.txt"]);
  });

  test("rejects stale manifest file path traversal before deleting outside the plugin directory", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const stale = policyFor({
      id: "platform.traversal-file",
      spec: "traversal-file",
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'stale';\n" }],
    });
    await materializePluginPolicies({ workspaceRoot, dataDir, policies: [stale] });

    const rootDir = join(workspaceRoot, ".opencode", "plugins", "veslo-managed");
    const manifestPath = join(rootDir, ".veslo-plugin-materialization.json");
    const manifest = await readJson(manifestPath) as {
      entries: Array<{ pluginDir: string; files: Array<Record<string, unknown>> }>;
    };
    const staleDir = manifest.entries[0]?.pluginDir ?? "";
    await writeFile(join(rootDir, "outside-owned-file.js"), "keep outside\n", "utf8");
    manifest.entries[0] = {
      ...manifest.entries[0],
      files: [
        {
          path: "../outside-owned-file.js",
          sha256: "0".repeat(64),
          sizeBytes: 13,
          executable: false,
        },
      ],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const next = policyFor({
      id: "platform.next-file",
      spec: "next-file",
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'next';\n" }],
    });

    await expect(materializePluginPolicies({ workspaceRoot, dataDir, policies: [next] }))
      .rejects.toThrow(/managed plugin file path/i);
    expect(await readFile(join(rootDir, "outside-owned-file.js"), "utf8")).toBe("keep outside\n");
    expect(await readFile(join(staleDir, ".veslo-managed-plugin.json"), "utf8")).toContain("platform.traversal-file");
  });

  test("rejects stale manifest pluginDir outside the managed root before deletion", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const stale = policyFor({
      id: "platform.root-mismatch",
      spec: "root-mismatch",
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'stale';\n" }],
    });
    await materializePluginPolicies({ workspaceRoot, dataDir, policies: [stale] });

    const rootDir = join(workspaceRoot, ".opencode", "plugins", "veslo-managed");
    const manifestPath = join(rootDir, ".veslo-plugin-materialization.json");
    const manifest = await readJson(manifestPath) as {
      entries: Array<Record<string, unknown>>;
    };
    const outsideDir = join(workspaceRoot, ".opencode", "plugins", "outside-managed");
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "plugin.js"), "keep outside plugin\n", "utf8");
    const outsideEntry = {
      ...manifest.entries[0],
      pluginDir: outsideDir,
      files: [
        {
          path: "plugin.js",
          sha256: "0".repeat(64),
          sizeBytes: 20,
          executable: false,
        },
      ],
    };
    await writeFile(
      join(outsideDir, ".veslo-managed-plugin.json"),
      `${JSON.stringify({ schemaVersion: 1, managedBy: "veslo-plugin-materializer", ...outsideEntry }, null, 2)}\n`,
      "utf8",
    );
    manifest.entries[0] = outsideEntry;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const next = policyFor({
      id: "platform.next-file",
      spec: "next-file",
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'next';\n" }],
    });

    await expect(materializePluginPolicies({ workspaceRoot, dataDir, policies: [next] }))
      .rejects.toThrow(/pluginDir/i);
    expect(await readFile(join(outsideDir, "plugin.js"), "utf8")).toBe("keep outside plugin\n");
  });

  test("rejects symlinked managed plugin directories before stale cleanup can delete outside files", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const outsideDir = await tempDir("veslo-plugin-materializer-outside-");
    const stale = policyFor({
      id: "platform.symlink-stale-file",
      spec: "symlink-stale-file",
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'stale';\n" }],
    });
    await materializePluginPolicies({ workspaceRoot, dataDir, policies: [stale] });

    const rootDir = join(workspaceRoot, ".opencode", "plugins", "veslo-managed");
    const manifestPath = join(rootDir, ".veslo-plugin-materialization.json");
    const manifest = await readJson(manifestPath) as {
      entries: Array<Record<string, unknown> & { pluginDir: string }>;
    };
    const staleDir = manifest.entries[0]?.pluginDir ?? "";
    await writeFile(join(outsideDir, "plugin.js"), "keep outside symlink target\n", "utf8");
    await writeFile(
      join(outsideDir, ".veslo-managed-plugin.json"),
      `${JSON.stringify({ schemaVersion: 1, managedBy: "veslo-plugin-materializer", ...manifest.entries[0] }, null, 2)}\n`,
      "utf8",
    );
    await rm(staleDir, { recursive: true, force: true });
    await symlink(outsideDir, staleDir, "dir");

    const next = policyFor({
      id: "platform.next-file",
      spec: "next-file",
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'next';\n" }],
    });

    await expect(materializePluginPolicies({ workspaceRoot, dataDir, policies: [next] }))
      .rejects.toThrow(/symlink|managed plugin directory/i);
    expect(await readFile(join(outsideDir, "plugin.js"), "utf8")).toBe("keep outside symlink target\n");
    expect(await readFile(join(outsideDir, ".veslo-managed-plugin.json"), "utf8")).toContain(stale.id);
  });

  test("rejects same-policy cleanup when the previous manifest points to an unaligned plugin directory", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const first = policyFor({
      id: "platform.same-policy-unaligned",
      spec: "same-policy-unaligned",
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'first';\n" }],
    });
    await materializePluginPolicies({ workspaceRoot, dataDir, policies: [first] });

    const rootDir = join(workspaceRoot, ".opencode", "plugins", "veslo-managed");
    const manifestPath = join(rootDir, ".veslo-plugin-materialization.json");
    const manifest = await readJson(manifestPath) as {
      entries: Array<Record<string, unknown>>;
    };
    const unalignedDir = join(rootDir, "manual-in-root");
    await mkdir(unalignedDir, { recursive: true });
    await writeFile(join(unalignedDir, "old-only.js"), "keep unaligned file\n", "utf8");
    manifest.entries[0] = {
      ...manifest.entries[0],
      pluginDir: unalignedDir,
      files: [
        {
          path: "old-only.js",
          sha256: "0".repeat(64),
          sizeBytes: 20,
          executable: false,
        },
      ],
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const updated = policyFor({
      id: first.id,
      spec: first.spec,
      target: "project",
      files: [{ path: "plugin.js", content: "export const name = 'updated';\n" }],
    });
    const result = await materializePluginPolicies({ workspaceRoot, dataDir, policies: [updated] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected materialization conflict");
    expect(result.conflicts).toContainEqual(expect.objectContaining({
      policyId: first.id,
      target: "project",
      path: unalignedDir,
    }));
    expect(await readFile(join(unalignedDir, "old-only.js"), "utf8")).toBe("keep unaligned file\n");
  });

  test("rejects invalid file policy paths before mutating config specs or manifests", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    await writeFile(
      join(workspaceRoot, "opencode.jsonc"),
      JSON.stringify({ plugin: ["unmanaged-before"] }, null, 2),
      "utf8",
    );
    const configPolicy = policyFor({
      id: "platform.valid-config-before-invalid-file",
      spec: "valid-config-before-invalid-file",
      target: "project",
    });
    const invalidFilePolicy = policyFor({
      id: "platform.invalid-file-path",
      spec: "invalid-file-path",
      target: "project",
      files: [{ path: "../escape.js", content: "export const bad = true;\n" }],
    });

    await expect(materializePluginPolicies({ workspaceRoot, dataDir, policies: [configPolicy, invalidFilePolicy] }))
      .rejects.toThrow(/managed plugin file path/i);

    const { data: config } = await readJsoncFile<Record<string, unknown>>(join(workspaceRoot, "opencode.jsonc"), {});
    expect(config.plugin).toEqual(["unmanaged-before"]);
    await expect(readFile(join(workspaceRoot, ".opencode", "veslo", "plugins", "managed-plugin-specs.json"), "utf8"))
      .rejects.toThrow();
    await expect(readFile(join(workspaceRoot, ".opencode", "plugins", "veslo-managed", ".veslo-plugin-materialization.json"), "utf8"))
      .rejects.toThrow();
  });

  test("listPlugins exposes malformed managed manifest ownership as a conflict instead of hiding it", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    await writeFile(
      join(workspaceRoot, "opencode.jsonc"),
      JSON.stringify({ plugin: ["managed-but-manifest-broken"] }, null, 2),
      "utf8",
    );
    const manifestPath = join(workspaceRoot, ".opencode", "veslo", "plugins", "managed-plugin-specs.json");
    await mkdir(join(workspaceRoot, ".opencode", "veslo", "plugins"), { recursive: true });
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        managedBy: "veslo-plugin-materializer",
        target: "project",
        generatedAt: new Date().toISOString(),
        entries: [{ policyId: "platform.broken", spec: "managed-but-manifest-broken" }],
      }, null, 2)}\n`,
      "utf8",
    );

    const plugins = await listPlugins(workspaceRoot, false);

    expect(plugins.warnings).toContainEqual(expect.objectContaining({
      code: "managed_plugin_manifest_invalid",
      path: manifestPath,
    }));
    expect(plugins.items).toContainEqual(expect.objectContaining({
      spec: "managed-but-manifest-broken",
      lifecycle: "conflict",
      conflict: expect.stringContaining("Managed plugin spec manifest"),
    }));
  });

  test("reports a conflict when a matching unmanaged config plugin already exists", async () => {
    const workspaceRoot = await tempDir("veslo-plugin-materializer-workspace-");
    const dataDir = await tempDir("veslo-plugin-materializer-data-");
    const policy = policyFor({ id: "platform.conflict", spec: "existing-plugin", target: "project" });
    await writeFile(
      join(workspaceRoot, "opencode.jsonc"),
      JSON.stringify({ plugin: [policy.spec, "other-unmanaged"] }, null, 2),
      "utf8",
    );

    const result = await materializePluginPolicies({ workspaceRoot, dataDir, policies: [policy] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected materialization conflict");
    expect(result.conflicts).toContainEqual(expect.objectContaining({
      code: "unmanaged_config_spec_conflict",
      policyId: policy.id,
      spec: policy.spec,
      target: "project",
    }));

    const { data: config } = await readJsoncFile<Record<string, unknown>>(join(workspaceRoot, "opencode.jsonc"), {});
    expect(config.plugin).toEqual([policy.spec, "other-unmanaged"]);
    await expect(readFile(join(workspaceRoot, ".opencode", "veslo", "plugins", "managed-plugin-specs.json"), "utf8"))
      .rejects.toThrow();
  });
});

function policyFor(input: {
  id: string;
  spec: string;
  target: "project" | "user";
  files?: MaterializablePluginPolicy["files"];
  effectiveEnabled?: boolean;
}): MaterializablePluginPolicy {
  return {
    id: input.id,
    spec: input.spec,
    displayName: input.id.replace(/^platform\./, ""),
    owner: { kind: "platform", id: "veslo-platform", label: "Veslo" },
    target: input.target,
    visibility: "visible",
    autoInstall: true,
    enabledPolicy: "user-toggleable",
    removalPolicy: "user-removable",
    source: "policy.platform",
    lifecycle: "active",
    effectiveEnabled: input.effectiveEnabled ?? true,
    ...(input.files ? { files: input.files } : {}),
  };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}
