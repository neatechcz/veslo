#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const appDirectory = join(root, "packages", "app");
const distDirectory = join(appDirectory, "dist");
const uploadEnvironmentKeys = ["SENTRY_URL", "SENTRY_AUTH_TOKEN", "SENTRY_ORG", "SENTRY_PROJECT"];
export const STAGING_RENDERER_CANARY_MARKER = "veslo.staging.renderer_canary";

function resolvePnpmInvocation() {
  if (process.platform !== "win32") return { command: "pnpm", prefixArgs: [] };

  const corepackPnpm = join(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js");
  if (existsSync(corepackPnpm)) {
    return { command: process.execPath, prefixArgs: [corepackPnpm] };
  }
  return { command: "cmd.exe", prefixArgs: ["/d", "/s", "/c", "pnpm.cmd"] };
}

const pnpm = resolvePnpmInvocation();

function isEnabled(value) {
  return /^(1|true|yes)$/i.test((value ?? "").trim());
}

export function stagingRendererCanaryEnabled(env = process.env) {
  return isEnabled(env.VESLO_STAGING_RENDERER_CANARY);
}

export function assertStagingRendererCanaryBuildPolicy(env = process.env) {
  if (!stagingRendererCanaryEnabled(env)) return;

  const environment =
    (env.VITE_VESLO_GLITCHTIP_ENVIRONMENT ?? "").trim() ||
    (env.VESLO_GLITCHTIP_ENVIRONMENT ?? "").trim() ||
    "production";
  if (environment !== "staging") {
    throw new Error("Staging renderer canary requires the GlitchTip environment to be staging.");
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listFiles(directory) {
  if (!existsSync(directory)) return [];

  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`Failed to start ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
  }
}

export function sourceMapPipelineEnabled(env = process.env) {
  return isEnabled(env.VESLO_GLITCHTIP_SOURCE_MAPS);
}

export function sourceMapUploadRequired(env = process.env) {
  return isEnabled(env.VESLO_REQUIRE_GLITCHTIP_SOURCE_MAP_UPLOAD);
}

export function missingSourceMapUploadEnvironment(env = process.env) {
  return uploadEnvironmentKeys.filter(key => !(env[key] ?? "").trim());
}

export function handleSourceMapUploadFailure(error, strict, warn = console.warn) {
  if (strict) throw error;
  const message = error instanceof Error ? error.message : String(error);
  warn(`GlitchTip source-map upload failed; continuing because it is optional: ${message}`);
}

export function sourceMapPairs(directory = distDirectory) {
  return listFiles(directory)
    .filter(path => path.endsWith(".js.map"))
    .map(mapPath => ({ mapPath, sourcePath: mapPath.slice(0, -4) }))
    .filter(({ sourcePath }) => existsSync(sourcePath));
}

export function removeSourceMapReferences(directory = distDirectory) {
  for (const path of listFiles(directory).filter(candidate => candidate.endsWith(".js"))) {
    const source = readFileSync(path, "utf8");
    const cleaned = source
      .replace(/\r?\n?\/\/[@#]\s*sourceMappingURL\s*=\s*[^\r\n]+\r?\n?/g, "\n")
      .replace(/^\s*\/\/[@#]\s*sourceMappingURL\s*=\s*[^\r\n]+\r?\n?/gm, "");
    if (cleaned !== source) writeFileSync(path, cleaned);
  }
}

export function removeSourceMaps(directory = distDirectory) {
  for (const path of listFiles(directory).filter(candidate => candidate.endsWith(".map"))) {
    rmSync(path, { force: true });
  }
}

export function assertNoSourceMapsRemain(directory = distDirectory) {
  const remainingMaps = listFiles(directory).filter(path => path.endsWith(".map"));
  if (remainingMaps.length > 0) {
    throw new Error(`Source maps remain in desktop frontend output: ${remainingMaps.join(", ")}`);
  }

  const publicSourceMapReferences = listFiles(directory)
    .filter(path => path.endsWith(".js"))
    .filter(path => /\/\/[@#]\s*sourceMappingURL\s*=/.test(readFileSync(path, "utf8")));
  if (publicSourceMapReferences.length > 0) {
    throw new Error(`Public frontend JavaScript still references source maps: ${publicSourceMapReferences.join(", ")}`);
  }
}

export function assertStagingRendererCanaryOutput(directory = distDirectory, enabled = false) {
  const canaryFiles = listFiles(directory)
    .filter(path => path.endsWith(".js"))
    .filter(path => readFileSync(path, "utf8").includes(STAGING_RENDERER_CANARY_MARKER));

  if (enabled && canaryFiles.length === 0) {
    throw new Error("Staging renderer canary was requested but is absent from the frontend build.");
  }
  if (!enabled && canaryFiles.length > 0) {
    throw new Error(`Staging renderer canary leaked into a regular frontend build: ${canaryFiles.join(", ")}`);
  }
}

export function assertInjectedDebugIds(pairs) {
  const evidence = [];
  for (const { mapPath, sourcePath } of pairs) {
    const map = readJson(mapPath);
    const debugId = typeof map.debug_id === "string" ? map.debug_id.trim() : "";
    const source = readFileSync(sourcePath, "utf8");
    const sourceDebugId = source.match(/\/\/\# debugId=([A-Za-z0-9-]+)/)?.[1] ?? "";

    if (!debugId || !sourceDebugId || debugId !== sourceDebugId) {
      throw new Error(`Debug ID injection is incomplete for ${sourcePath}.`);
    }
    evidence.push({
      source: relative(root, sourcePath).replaceAll("\\", "/"),
      sourceMap: relative(root, mapPath).replaceAll("\\", "/"),
      debugId,
    });
  }
  return evidence;
}

function resolveReleaseMetadata(env = process.env) {
  const appVersion = readJson(join(appDirectory, "package.json")).version;
  const desktopVersion = readJson(join(root, "packages", "desktop", "package.json")).version;
  const tauriVersion = readJson(join(root, "packages", "desktop", "src-tauri", "tauri.conf.json")).version;
  if (![appVersion, desktopVersion, tauriVersion].every(version => version === appVersion)) {
    throw new Error("Desktop, app, and Tauri versions must match before uploading source maps.");
  }

  const commit = (env.GITHUB_SHA ?? "").trim() || resolveCommit();
  const environment =
    (env.VITE_VESLO_GLITCHTIP_ENVIRONMENT ?? "").trim() ||
    (env.VESLO_GLITCHTIP_ENVIRONMENT ?? "").trim() ||
    "production";

  return {
    release: `veslo@${appVersion}`,
    environment,
    commit: commit || null,
  };
}

function resolveCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function commandIsAvailable(command, env = process.env) {
  const result = spawnSync(command, ["--version"], {
    cwd: root,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

function writeEvidence(path, metadata, artifacts) {
  if (!path?.trim()) return;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        ...metadata,
        uploadedAt: new Date().toISOString(),
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
}

function buildUi(env = process.env) {
  run(pnpm.command, [...pnpm.prefixArgs, "--filter", "@neatech/veslo-ui", "build"], { env });
  assertStagingRendererCanaryOutput(distDirectory, stagingRendererCanaryEnabled(env));
}

function runSourceMapPipeline(env = process.env) {
  const metadata = resolveReleaseMetadata(env);
  const missing = missingSourceMapUploadEnvironment(env);
  const strict = sourceMapUploadRequired(env);
  const cli = env.VESLO_GLITCHTIP_CLI?.trim() || "glitchtip-cli";

  buildUi({ ...env, VESLO_GLITCHTIP_SOURCE_MAPS: "1" });
  const pairs = sourceMapPairs();
  if (pairs.length === 0) {
    throw new Error("Release frontend build did not produce JavaScript source maps.");
  }

  try {
    if (missing.length > 0) {
      const message = `Missing GlitchTip source-map upload env: ${missing.join(", ")}.`;
      if (strict) throw new Error(message);
      console.warn(`${message} Continuing without source-map upload.`);
      return;
    }

    if (!commandIsAvailable(cli, env)) {
      const message = `GlitchTip source-map CLI is unavailable: ${cli}.`;
      if (strict) throw new Error(message);
      console.warn(`${message} Continuing without source-map upload.`);
      return;
    }

    run(cli, ["sourcemaps", "inject", "--ext", "js", distDirectory], { env });
    const artifacts = assertInjectedDebugIds(pairs);
    run(
      cli,
      [
        "sourcemaps",
        "upload",
        "--release",
        metadata.release,
        "--url-prefix",
        "~",
        "--ext",
        "js",
        "--ext",
        "map",
        "--validate",
        distDirectory,
      ],
      { env },
    );
    const evidencePath =
      env.VESLO_GLITCHTIP_SOURCE_MAP_EVIDENCE_PATH ||
      (env.RUNNER_TEMP ? join(env.RUNNER_TEMP, "veslo-glitchtip-source-map-evidence.json") : "");
    writeEvidence(evidencePath, metadata, artifacts);
  } catch (error) {
    handleSourceMapUploadFailure(error, strict);
  } finally {
    removeSourceMapReferences();
    removeSourceMaps();
    assertNoSourceMapsRemain();
  }
}

export function main(env = process.env) {
  assertStagingRendererCanaryBuildPolicy(env);
  if (!sourceMapPipelineEnabled(env)) {
    buildUi(env);
    return;
  }

  runSourceMapPipeline(env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
