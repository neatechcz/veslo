import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { manifestFileCandidates, readVersionManifestFromDirs } from "../version-manifest";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("version manifest resolution", () => {
  test("includes target-suffixed Windows manifest candidates", () => {
    expect(manifestFileCandidates("win32", "x86_64-pc-windows-msvc")).toEqual([
      "versions.json",
      "versions.json.exe",
      "versions.json-x86_64-pc-windows-msvc",
      "versions.json-x86_64-pc-windows-msvc.exe",
    ]);
  });

  test("reads a Windows target-suffixed manifest when canonical versions.json is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veslo-version-manifest-"));
    tempDirs.push(dir);

    await writeFile(
      join(dir, "versions.json-x86_64-pc-windows-msvc.exe"),
      JSON.stringify({
        "veslo-server": { version: "2026.3.7", sha256: "serverhash" },
      }),
      "utf8",
    );

    const manifest = await readVersionManifestFromDirs([dir], {
      platform: "win32",
      target: "x86_64-pc-windows-msvc",
    });

    expect(manifest).not.toBeNull();
    expect(manifest?.dir).toBe(dir);
    expect(manifest?.entries["veslo-server"]?.version).toBe("2026.3.7");
  });

  test("reads the Windows Tauri dev manifest copied as versions.json.exe", async () => {
    const dir = await mkdtemp(join(tmpdir(), "veslo-version-manifest-"));
    tempDirs.push(dir);

    await writeFile(
      join(dir, "versions.json.exe"),
      JSON.stringify({
        "veslo-code": { version: "1.17.13", sha256: "codehash" },
      }),
      "utf8",
    );

    const manifest = await readVersionManifestFromDirs([dir], {
      platform: "win32",
    });

    expect(manifest).not.toBeNull();
    expect(manifest?.dir).toBe(dir);
    expect(manifest?.entries["veslo-code"]?.version).toBe("1.17.13");
  });
});
