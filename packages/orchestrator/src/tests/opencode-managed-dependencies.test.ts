import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ensureOpencodeManagedTools,
  VESLO_MANAGED_AI_SDK_PROVIDER_UTILS_VERSION,
  VESLO_MANAGED_AI_SDK_PROVIDER_VERSION,
  VESLO_MANAGED_EVENTSOURCE_PARSER_VERSION,
  VESLO_MANAGED_JSON_SCHEMA_VERSION,
  VESLO_MANAGED_OPENAI_COMPATIBLE_VERSION,
  VESLO_MANAGED_PLUGIN_VERSION,
  VESLO_MANAGED_STANDARD_SCHEMA_SPEC_VERSION,
  VESLO_MANAGED_WORKFLOW_SERDE_VERSION,
  VESLO_MANAGED_ZOD_VERSION,
} from "../opencode-managed-dependencies.js";

const managedPackageSpecs = [
  { name: "@opencode-ai/plugin", version: VESLO_MANAGED_PLUGIN_VERSION },
  { name: "zod", version: VESLO_MANAGED_ZOD_VERSION },
  { name: "@ai-sdk/openai-compatible", version: VESLO_MANAGED_OPENAI_COMPATIBLE_VERSION },
  { name: "@ai-sdk/provider", version: VESLO_MANAGED_AI_SDK_PROVIDER_VERSION },
  { name: "@ai-sdk/provider-utils", version: VESLO_MANAGED_AI_SDK_PROVIDER_UTILS_VERSION },
  { name: "@standard-schema/spec", version: VESLO_MANAGED_STANDARD_SCHEMA_SPEC_VERSION },
  { name: "@workflow/serde", version: VESLO_MANAGED_WORKFLOW_SERDE_VERSION },
  { name: "eventsource-parser", version: VESLO_MANAGED_EVENTSOURCE_PARSER_VERSION },
  { name: "json-schema", version: VESLO_MANAGED_JSON_SCHEMA_VERSION },
] as const;

function packagePathParts(name: string): string[] {
  return name.split("/").filter(Boolean);
}

function nodeModulePackageDir(root: string, name: string): string {
  return join(root, "node_modules", ...packagePathParts(name));
}

async function writePackageJson(dir: string, pkg: Record<string, unknown>) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

async function writeManagedPackage(root: string, name: string, version: string) {
  await writePackageJson(nodeModulePackageDir(root, name), {
    name,
    version,
    type: "module",
  });
}

async function seedManagedPackages(root: string, omit: string[] = []) {
  const omitted = new Set(omit);
  for (const spec of managedPackageSpecs) {
    if (omitted.has(spec.name)) continue;
    await writeManagedPackage(root, spec.name, spec.version);
  }
}

function simpleManagedManifestPackage(name: string, version: string, includeEmptyFile = false) {
  return {
    name,
    version,
    files: [
      {
        path: "package.json",
        content: `${JSON.stringify({ name, version, type: "module" })}\n`,
      },
      ...(includeEmptyFile ? [{ path: "dist/index.js", content: "" }] : []),
    ],
  };
}

async function writeManagedDepsManifest(
  manifestPath: string,
  packages: Array<{
    name: string;
    version: string;
    files: Array<{ path: string; content: string }>;
  }>,
) {
  await mkdir(join(manifestPath, ".."), { recursive: true });
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        packages: packages.map((pkg) => ({
          name: pkg.name,
          version: pkg.version,
          files: pkg.files.map((file) => ({
            path: file.path,
            contentBase64: Buffer.from(file.content, "utf8").toString("base64"),
          })),
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("ensureOpencodeManagedTools", () => {
  test("vendors zod into configDir and emits dependency status", async () => {
    const root = await mkdtemp(join(tmpdir(), "veslo-managed-deps-"));
    const home = join(root, "home");
    const configDir = join(root, "config");
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

    await seedManagedPackages(configDir, ["zod"]);
    await writePackageJson(
      join(home, ".bun", "install", "cache", "zod@4.1.8@@@1"),
      {
        name: "zod",
        version: "4.1.8",
        type: "module",
      },
    );

    await ensureOpencodeManagedTools(configDir, {
      home,
      emit: (event, payload) => events.push({ event, payload }),
    });

    const zodPackageJson = JSON.parse(
      await readFile(join(configDir, "node_modules", "zod", "package.json"), "utf8"),
    ) as { version?: string };
    expect(zodPackageJson.version).toBe("4.1.8");
    const configPackageJson = JSON.parse(await readFile(join(configDir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(configPackageJson.dependencies?.["@ai-sdk/openai-compatible"]).toBe("3.0.5");
    expect(configPackageJson.dependencies?.["@opencode-ai/plugin"]).toBeUndefined();

    const status = events.find((entry) => entry.event === "opencode-managed-dependencies:status");
    expect(status?.payload).toMatchObject({
      configDir,
      pluginMode: "vendored",
      zodMode: "vendored",
      zodVersion: "4.1.8",
      openAiCompatibleMode: "vendored",
      openAiCompatibleVersion: "3.0.5",
    });
  });

  test("uses Windows USERPROFILE for Bun cache when HOME is empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "veslo-managed-deps-win-home-"));
    const userProfile = join(root, "user-profile");
    const configDir = join(root, "config");
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalHomeDrive = process.env.HOMEDRIVE;
    const originalHomePath = process.env.HOMEPATH;

    await seedManagedPackages(configDir, ["zod"]);
    await writePackageJson(
      join(userProfile, ".bun", "install", "cache", "zod@4.1.8@@@1"),
      {
        name: "zod",
        version: "4.1.8",
        type: "module",
      },
    );

    try {
      process.env.HOME = "";
      process.env.USERPROFILE = userProfile;
      delete process.env.HOMEDRIVE;
      delete process.env.HOMEPATH;

      await ensureOpencodeManagedTools(configDir, {
        emit: (event, payload) => events.push({ event, payload }),
      });
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalUserProfile;
      if (originalHomeDrive === undefined) delete process.env.HOMEDRIVE;
      else process.env.HOMEDRIVE = originalHomeDrive;
      if (originalHomePath === undefined) delete process.env.HOMEPATH;
      else process.env.HOMEPATH = originalHomePath;
    }

    const zodPackageJson = JSON.parse(
      await readFile(join(configDir, "node_modules", "zod", "package.json"), "utf8"),
    ) as { version?: string };
    expect(zodPackageJson.version).toBe("4.1.8");

    const vendored = events.find(
      (entry) =>
        entry.event === "opencode-managed-dependencies:vendored" &&
        entry.payload.package === "zod",
    );
    expect(vendored?.payload).toMatchObject({
      package: "zod",
      version: "4.1.8",
      home: userProfile,
      homeSource: "USERPROFILE",
    });
  });

  test("replaces fallback plugin with managed real package manifest for every configDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "veslo-managed-deps-manifest-"));
    const home = join(root, "home-without-cache");
    const configDir = join(root, "config");
    const manifestPath = join(root, "opencode-managed-deps.json");
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

    await writePackageJson(
      join(configDir, "node_modules", "@opencode-ai", "plugin"),
      {
        name: "@opencode-ai/plugin",
        version: "0.0.0-veslo-managed",
        type: "module",
      },
    );
    await writeManagedDepsManifest(manifestPath, [
      {
        name: "@opencode-ai/plugin",
        version: VESLO_MANAGED_PLUGIN_VERSION,
        files: [
          {
            path: "package.json",
            content: `${JSON.stringify({
              name: "@opencode-ai/plugin",
              version: VESLO_MANAGED_PLUGIN_VERSION,
              type: "module",
              exports: {
                ".": { import: "./dist/index.js" },
                "./tool": { import: "./dist/tool.js" },
              },
            })}\n`,
          },
          { path: "dist/index.js", content: "export * from '../tool.js';\n" },
          { path: "dist/tool.js", content: "export const tool = (input) => input;\n" },
        ],
      },
      {
        name: "zod",
        version: "4.1.8",
        files: [
          {
            path: "package.json",
            content: `${JSON.stringify({
              name: "zod",
              version: "4.1.8",
              type: "module",
            })}\n`,
          },
          { path: "index.js", content: "export const z = {};\n" },
        ],
      },
      ...managedPackageSpecs
        .filter((spec) => spec.name !== "@opencode-ai/plugin" && spec.name !== "zod")
        .map((spec) =>
          simpleManagedManifestPackage(
            spec.name,
            spec.version,
            spec.name === "@standard-schema/spec",
          )
        ),
    ]);

    await ensureOpencodeManagedTools(configDir, {
      home,
      managedDepsManifestPath: manifestPath,
      emit: (event, payload) => events.push({ event, payload }),
    });

    const pluginPackageJson = JSON.parse(
      await readFile(join(configDir, "node_modules", "@opencode-ai", "plugin", "package.json"), "utf8"),
    ) as { version?: string };
    const zodPackageJson = JSON.parse(
      await readFile(join(configDir, "node_modules", "zod", "package.json"), "utf8"),
    ) as { version?: string };
    const openAiCompatiblePackageJson = JSON.parse(
      await readFile(
        join(configDir, "node_modules", "@ai-sdk", "openai-compatible", "package.json"),
        "utf8",
      ),
    ) as { version?: string };
    expect(pluginPackageJson.version).toBe(VESLO_MANAGED_PLUGIN_VERSION);
    expect(zodPackageJson.version).toBe("4.1.8");
    expect(openAiCompatiblePackageJson.version).toBe("3.0.5");

    const status = events.find((entry) => entry.event === "opencode-managed-dependencies:status");
    expect(status?.payload).toMatchObject({
      configDir,
      pluginMode: "vendored",
      pluginVersion: VESLO_MANAGED_PLUGIN_VERSION,
      zodMode: "vendored",
      zodVersion: "4.1.8",
      openAiCompatibleMode: "vendored",
      openAiCompatibleVersion: "3.0.5",
    });
    expect(events.some((entry) => entry.event === "opencode-managed-dependencies:plugin-fallback-written")).toBe(false);
  });

  test("falls back to local node_modules when manifest and Bun cache are unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "veslo-managed-deps-node-modules-"));
    const home = join(root, "home-without-cache");
    const configDir = join(root, "config");
    const repoRoot = join(root, "repo");
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

    await seedManagedPackages(repoRoot);

    await ensureOpencodeManagedTools(configDir, {
      home,
      nodeModuleSearchRoots: [repoRoot],
      emit: (event, payload) => events.push({ event, payload }),
    });

    const pluginPackageJson = JSON.parse(
      await readFile(join(configDir, "node_modules", "@opencode-ai", "plugin", "package.json"), "utf8"),
    ) as { version?: string };
    const zodPackageJson = JSON.parse(
      await readFile(join(configDir, "node_modules", "zod", "package.json"), "utf8"),
    ) as { version?: string };
    const openAiCompatiblePackageJson = JSON.parse(
      await readFile(
        join(configDir, "node_modules", "@ai-sdk", "openai-compatible", "package.json"),
        "utf8",
      ),
    ) as { version?: string };
    expect(pluginPackageJson.version).toBe(VESLO_MANAGED_PLUGIN_VERSION);
    expect(zodPackageJson.version).toBe("4.1.8");
    expect(openAiCompatiblePackageJson.version).toBe("3.0.5");

    const vendoredSources = events
      .filter((entry) => entry.event === "opencode-managed-dependencies:vendored")
      .map((entry) => entry.payload.source);
    expect(vendoredSources).toEqual(managedPackageSpecs.map(() => "node-modules"));
  });
});
