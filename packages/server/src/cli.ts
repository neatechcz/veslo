#!/usr/bin/env bun

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { parseCliArgs, printHelp, resolveServerConfig } from "./config.js";
import { createServerLogger, startServer } from "./server.js";
import type { ServerConfig } from "./types.js";
import pkg from "../package.json" with { type: "json" };

type RuntimeDescriptor = {
  schemaVersion: 1;
  type: "veslo.server.ready";
  instanceId: string | null;
  host: string;
  port: number;
  pid: number;
  startedAt: number;
  baseUrl: string;
};

function runtimeDescriptor(config: ServerConfig, port: number): RuntimeDescriptor {
  return {
    schemaVersion: 1,
    type: "veslo.server.ready",
    instanceId: config.instanceId ?? null,
    host: config.host,
    port,
    pid: process.pid,
    startedAt: config.startedAt,
    baseUrl: `http://${config.host}:${port}`,
  };
}

async function writeRuntimeDescriptorAtomically(path: string, descriptor: RuntimeDescriptor): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

const args = parseCliArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.version) {
  console.log(pkg.version);
  process.exit(0);
}

const config = await resolveServerConfig(args);
const logger = createServerLogger(config);
const server = startServer(config);

const url = `http://${config.host}:${server.port}`;
logger.log("info", `Veslo server listening on ${url}`);
const descriptor = runtimeDescriptor(config, server.port);
if (config.runtimeDescriptorPath) {
  try {
    await writeRuntimeDescriptorAtomically(config.runtimeDescriptorPath, descriptor);
  } catch (error) {
    logger.log("error", "Failed to write Veslo server runtime descriptor", {
      path: config.runtimeDescriptorPath,
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  }
}
console.log(`VESLO_SERVER_READY ${JSON.stringify(descriptor)}`);

if (config.tokenSource === "generated") {
  logger.log("info", `Client token: ${config.token}`);
}

if (config.hostTokenSource === "generated") {
  logger.log("info", `Host token: ${config.hostToken}`);
}

if (config.workspaces.length === 0) {
  logger.log("info", "No workspaces configured. Add --workspace or update server.json.");
} else {
  logger.log("info", `Workspaces: ${config.workspaces.length}`);
}

if (args.verbose) {
  logger.log("info", `Config path: ${config.configPath ?? "unknown"}`);
  logger.log("info", `Read-only: ${config.readOnly ? "true" : "false"}`);
  logger.log("info", `Approval: ${config.approval.mode} (${config.approval.timeoutMs}ms)`);
  logger.log("info", `CORS origins: ${config.corsOrigins.join(", ")}`);
  logger.log("info", `Authorized roots: ${config.authorizedRoots.join(", ")}`);
  logger.log("info", `Token source: ${config.tokenSource}`);
  logger.log("info", `Host token source: ${config.hostTokenSource}`);
  logger.log("info", `Debug log shipping: ${config.debugLogs.enabled ? "enabled" : "disabled"}`);
}
