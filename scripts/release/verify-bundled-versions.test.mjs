import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  findBundledVersionsManifest,
  verifyBundledSidecars,
} from "./verify-bundled-versions.mjs";
import { sha256WindowsAuthenticode } from "./windows-authenticode-hash.mjs";

const verifierCliPath = fileURLToPath(
  new URL("./verify-bundled-versions.mjs", import.meta.url),
);

const writeText = (filePath, value) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf8");
};

const executableContent = "#!/bin/sh\nexit 0\n";
const managedDepsContent = "{}\n";
const sha256Text = (value) => createHash("sha256").update(value).digest("hex");

const makeMinimalWindowsPe = () => {
  const buffer = Buffer.alloc(0x400);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(0x8664, 0x84);
  buffer.writeUInt16LE(0xf0, 0x94);

  const optionalHeaderOffset = 0x98;
  buffer.writeUInt16LE(0x20b, optionalHeaderOffset);
  buffer.writeUInt32LE(16, optionalHeaderOffset + 108);
  buffer.write("Windows executable payload", 0x200, "utf8");
  return buffer;
};

const withWindowsSignature = (unsigned) => {
  const signed = Buffer.concat([
    Buffer.from(unsigned),
    Buffer.from("certificate bytes", "utf8"),
  ]);
  const optionalHeaderOffset = 0x98;
  const certificateDirectoryOffset = optionalHeaderOffset + 112 + 4 * 8;

  signed.writeUInt32LE(0x12345678, optionalHeaderOffset + 64);
  signed.writeUInt32LE(unsigned.length, certificateDirectoryOffset);
  signed.writeUInt32LE(
    signed.length - unsigned.length,
    certificateDirectoryOffset + 4,
  );
  return signed;
};

const writeExecutable = (filePath) => {
  writeText(filePath, executableContent);
  chmodSync(filePath, 0o755);
};

const writeWindowsExecutable = (filePath, content) => {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  chmodSync(filePath, 0o755);
};

const versionsManifest = (overrides = {}, executableSha256 = sha256Text(executableContent)) =>
  JSON.stringify(
    {
    "veslo-code": {
      version: "1.0.0",
      sha256: executableSha256,
    },
    "veslo-server": {
      version: "1.0.0",
      sha256: executableSha256,
    },
    "veslo-code-router": {
      version: "1.0.0",
      sha256: executableSha256,
    },
    "veslo-orchestrator": {
      version: "1.0.0",
      sha256: executableSha256,
    },
    "chrome-devtools-mcp": {
      version: "1.0.0",
      sha256: executableSha256,
    },
    "opencode-managed-deps": {
      version: "1.0.0",
      sha256: sha256Text(managedDepsContent),
    },
    ...overrides,
    },
    null,
    2,
  );

test("runs its CLI validation when invoked with a Windows filesystem path", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-versions-cli-"));

  try {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [verifierCliPath, fixtureRoot, "x86_64-pc-windows-msvc"],
          { encoding: "utf8", stdio: "pipe" },
        ),
      (error) => {
        assert.match(String(error.stderr), /versions\.json missing from bundle/);
        return true;
      },
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("finds versions.json inside the extracted macOS app bundle even when the app name is not Veslo.app", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-versions-"));

  try {
    const manifestPath = join(
      fixtureRoot,
      "Veslo by Neatech.app",
      "Contents",
      "MacOS",
      "versions.json",
    );
    writeText(manifestPath, "{\n}\n");

    const found = findBundledVersionsManifest(fixtureRoot, {
      targetTriple: "x86_64-apple-darwin",
    });

    assert.equal(found, manifestPath);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("falls back to a target-suffixed versions manifest when needed", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-versions-"));

  try {
    const manifestPath = join(
      fixtureRoot,
      "Veslo by Neatech.app",
      "Contents",
      "MacOS",
      "versions.json-aarch64-apple-darwin",
    );
    writeText(manifestPath, "{\n}\n");

    const found = findBundledVersionsManifest(fixtureRoot, {
      targetTriple: "aarch64-apple-darwin",
    });

    assert.equal(found, manifestPath);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("finds the Windows .exe manifest copied into the target release directory", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-versions-windows-"));

  try {
    const manifestPath = join(fixtureRoot, "versions.json.exe");
    writeText(manifestPath, "{\n}\n");

    const found = findBundledVersionsManifest(fixtureRoot, {
      targetTriple: "x86_64-pc-windows-msvc",
    });

    assert.equal(found, manifestPath);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("verifies bundled sidecars and manifest hashes in an extracted macOS app bundle", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-sidecars-"));

  try {
    const appPath = join(fixtureRoot, "Veslo by Neatech.app");
    const macosPath = join(appPath, "Contents", "MacOS");
    const targetTriple = "aarch64-apple-darwin";
    writeText(join(macosPath, `versions.json-${targetTriple}`), versionsManifest());
    for (const name of [
      "veslo-code",
      "opencode",
      "veslo-server",
      "veslo-code-router",
      "veslo-orchestrator",
      "chrome-devtools-mcp",
    ]) {
      writeExecutable(join(macosPath, `${name}-${targetTriple}`));
    }
    writeText(join(macosPath, `opencode-managed-deps.json-${targetTriple}`), managedDepsContent);

    const result = verifyBundledSidecars(fixtureRoot, { targetTriple });

    assert.equal(result.manifestPath, join(macosPath, `versions.json-${targetTriple}`));
    assert.deepEqual(
      result.sidecars.map((sidecar) => sidecar.name),
      [
        "veslo-code",
        "opencode",
        "veslo-server",
        "veslo-code-router",
        "veslo-orchestrator",
        "chrome-devtools-mcp",
        "opencode-managed-deps.json",
      ],
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("fails when the bundled Veslo server sidecar is missing", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-sidecars-missing-"));

  try {
    const appPath = join(fixtureRoot, "Veslo by Neatech.app");
    const macosPath = join(appPath, "Contents", "MacOS");
    const targetTriple = "aarch64-apple-darwin";
    writeText(join(macosPath, `versions.json-${targetTriple}`), versionsManifest());
    for (const name of [
      "veslo-code",
      "opencode",
      "veslo-code-router",
      "veslo-orchestrator",
      "chrome-devtools-mcp",
    ]) {
      writeExecutable(join(macosPath, `${name}-${targetTriple}`));
    }
    writeText(join(macosPath, `opencode-managed-deps.json-${targetTriple}`), managedDepsContent);

    assert.throws(
      () => verifyBundledSidecars(fixtureRoot, { targetTriple }),
      /veslo-server missing from bundle/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("verifies bundled sidecars in a Windows target release directory", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-windows-sidecars-"));

  try {
    const targetTriple = "x86_64-pc-windows-msvc";
    const unsignedWindowsExecutable = makeMinimalWindowsPe();
    const signedWindowsExecutable = withWindowsSignature(unsignedWindowsExecutable);
    const manifestExecutableHash = sha256WindowsAuthenticode(unsignedWindowsExecutable);
    writeText(
      join(fixtureRoot, `versions.json-${targetTriple}.exe`),
      versionsManifest({}, manifestExecutableHash),
    );
    for (const name of [
      "veslo-code",
      "opencode",
      "veslo-server",
      "veslo-code-router",
      "veslo-orchestrator",
      "chrome-devtools-mcp",
      "veslo-node",
    ]) {
      writeWindowsExecutable(
        join(fixtureRoot, `${name}-${targetTriple}.exe`),
        signedWindowsExecutable,
      );
    }
    writeText(join(fixtureRoot, `opencode-managed-deps.json-${targetTriple}.exe`), managedDepsContent);

    const result = verifyBundledSidecars(fixtureRoot, { targetTriple });

    assert.equal(result.appPath, fixtureRoot);
    assert.equal(result.manifestPath, join(fixtureRoot, `versions.json-${targetTriple}.exe`));
    assert.deepEqual(
      result.sidecars.map((sidecar) => sidecar.name),
      [
        "veslo-code",
        "opencode",
        "veslo-server",
        "veslo-code-router",
        "veslo-orchestrator",
        "chrome-devtools-mcp",
        "veslo-node",
        "opencode-managed-deps.json",
      ],
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("fails when the bundled sidecar hash does not match versions.json", () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "veslo-bundled-sidecars-hash-mismatch-"));

  try {
    const appPath = join(fixtureRoot, "Veslo by Neatech.app");
    const macosPath = join(appPath, "Contents", "MacOS");
    const targetTriple = "aarch64-apple-darwin";
    writeText(
      join(macosPath, `versions.json-${targetTriple}`),
      versionsManifest({
        "veslo-server": {
          version: "1.0.0",
          sha256: "0".repeat(64),
        },
      }),
    );
    for (const name of [
      "veslo-code",
      "opencode",
      "veslo-server",
      "veslo-code-router",
      "veslo-orchestrator",
      "chrome-devtools-mcp",
    ]) {
      writeExecutable(join(macosPath, `${name}-${targetTriple}`));
    }
    writeText(join(macosPath, `opencode-managed-deps.json-${targetTriple}`), managedDepsContent);

    assert.throws(
      () => verifyBundledSidecars(fixtureRoot, { targetTriple }),
      /sha256 mismatch for veslo-server/,
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
