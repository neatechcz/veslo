#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "../load-env.mjs";

const scriptDir = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repositoryRoot = resolve(scriptDir, "../..");

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}. Add it to ${join(repositoryRoot, ".env")}.`);
  return value;
}

function usage() {
  return `Usage:
  node scripts/admin/production-ssh.mjs --status
  node scripts/admin/production-ssh.mjs -- "<remote command>"

Configuration is read from the gitignored root .env:
  VESLO_PRODUCTION_SSH_HOST
  VESLO_PRODUCTION_SSH_USER
  VESLO_PRODUCTION_SSH_IDENTITY_FILE
  VESLO_PRODUCTION_SSH_PASSPHRASE  (optional when ssh-agent already has the key)`;
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === "--status") {
    return ["whoami; hostname; pwd"];
  }
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    process.exit(0);
  }
  if (argv[0] !== "--" || argv.length !== 2) {
    throw new Error(`Pass exactly one remote command after --.\n\n${usage()}`);
  }
  return [argv[1]];
}

async function createAskPass() {
  const directory = await mkdtemp(join(tmpdir(), "veslo-production-ssh-"));
  const path = join(directory, "askpass.cmd");
  const content = [
    "@echo off",
    "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command \"[Console]::Out.Write([Environment]::GetEnvironmentVariable('VESLO_PRODUCTION_SSH_PASSPHRASE'))\"",
    "",
  ].join("\r\n");
  await writeFile(path, content, { encoding: "utf8", mode: 0o700 });
  return { directory, path };
}

async function main() {
  loadDotEnv({ cwd: repositoryRoot });
  const remoteCommand = parseArgs(process.argv.slice(2));
  const host = requiredEnv("VESLO_PRODUCTION_SSH_HOST");
  const user = requiredEnv("VESLO_PRODUCTION_SSH_USER");
  const identityFile = requiredEnv("VESLO_PRODUCTION_SSH_IDENTITY_FILE");
  const passphrase = process.env.VESLO_PRODUCTION_SSH_PASSPHRASE?.trim();
  const askPass = passphrase ? await createAskPass() : null;
  const authOptions = passphrase ? [] : ["-o", "BatchMode=yes"];

  const args = [
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=10",
    ...authOptions,
    "-i",
    identityFile,
    `${user}@${host}`,
    ...remoteCommand,
  ];
  const environment = {
    ...process.env,
    ...(askPass
      ? { SSH_ASKPASS: askPass.path, SSH_ASKPASS_REQUIRE: "force", DISPLAY: "veslo" }
      : {}),
  };

  try {
    const child = spawn("ssh", args, { env: environment, stdio: "inherit" });
    const code = await new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolveCode(exitCode ?? (signal ? 1 : 0)));
    });
    process.exitCode = code;
  } finally {
    if (askPass) await rm(askPass.directory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
