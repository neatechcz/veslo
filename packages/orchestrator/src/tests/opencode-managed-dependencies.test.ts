import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureOpencodeManagedTools } from "../opencode-managed-dependencies.js";

async function writePackageJson(dir: string, pkg: Record<string, unknown>) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
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

    await writePackageJson(
      join(configDir, "node_modules", "@opencode-ai", "plugin"),
      {
        name: "@opencode-ai/plugin",
        version: "1.14.29",
        type: "module",
      },
    );
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

    const status = events.find((entry) => entry.event === "opencode-managed-dependencies:status");
    expect(status?.payload).toMatchObject({
      configDir,
      pluginMode: "vendored",
      zodMode: "vendored",
      zodVersion: "4.1.8",
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

    await writePackageJson(
      join(configDir, "node_modules", "@opencode-ai", "plugin"),
      {
        name: "@opencode-ai/plugin",
        version: "1.14.29",
        type: "module",
      },
    );
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
        version: "1.14.29",
        files: [
          {
            path: "package.json",
            content: `${JSON.stringify({
              name: "@opencode-ai/plugin",
              version: "1.14.29",
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
    expect(pluginPackageJson.version).toBe("1.14.29");
    expect(zodPackageJson.version).toBe("4.1.8");

    const status = events.find((entry) => entry.event === "opencode-managed-dependencies:status");
    expect(status?.payload).toMatchObject({
      configDir,
      pluginMode: "vendored",
      pluginVersion: "1.14.29",
      zodMode: "vendored",
      zodVersion: "4.1.8",
    });
    expect(events.some((entry) => entry.event === "opencode-managed-dependencies:plugin-fallback-written")).toBe(false);
  });

  test("falls back to local node_modules when manifest and Bun cache are unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "veslo-managed-deps-node-modules-"));
    const home = join(root, "home-without-cache");
    const configDir = join(root, "config");
    const repoRoot = join(root, "repo");
    const events: Array<{ event: string; payload: Record<string, unknown> }> = [];

    await writePackageJson(
      join(repoRoot, "node_modules", "@opencode-ai", "plugin"),
      {
        name: "@opencode-ai/plugin",
        version: "1.14.29",
        type: "module",
      },
    );
    await writePackageJson(
      join(repoRoot, "node_modules", "zod"),
      {
        name: "zod",
        version: "4.1.8",
        type: "module",
      },
    );

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
    expect(pluginPackageJson.version).toBe("1.14.29");
    expect(zodPackageJson.version).toBe("4.1.8");

    const vendoredSources = events
      .filter((entry) => entry.event === "opencode-managed-dependencies:vendored")
      .map((entry) => entry.payload.source);
    expect(vendoredSources).toEqual(["node-modules", "node-modules"]);
  });
});
