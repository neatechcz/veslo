#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import readline from "node:readline/promises"

const CONFIG_OVERRIDE = 'cli_auth_credentials_store="file"'

export function parseArgs(argv) {
  const options = {
    uploadUrl: "",
    credentialId: "",
    credentialName: "",
    authJsonPath: "",
    profileDir: "",
    yes: false,
    dryRun: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--yes" || arg === "-y") {
      options.yes = true
      continue
    }
    if (arg === "--dry-run") {
      options.dryRun = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      throw new UsageError(usage())
    }

    const value = argv[index + 1]
    if (!value || value.startsWith("--")) {
      throw new UsageError(`Missing value for ${arg}.\n\n${usage()}`)
    }
    index += 1

    switch (arg) {
      case "--upload-url":
        options.uploadUrl = value
        break
      case "--credential-id":
        options.credentialId = value
        break
      case "--credential-name":
        options.credentialName = value
        break
      case "--auth-json-path":
        options.authJsonPath = value
        break
      case "--profile-dir":
        options.profileDir = value
        break
      default:
        throw new UsageError(`Unknown option ${arg}.\n\n${usage()}`)
    }
  }

  return options
}

export function validateCodexAuthJson(raw) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("auth.json is not valid JSON.")
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("auth.json must be a JSON object.")
  }
  if (typeof parsed.auth_mode !== "string" || !parsed.auth_mode.trim()) {
    throw new Error("auth.json is missing auth_mode.")
  }
  if (!parsed.tokens || typeof parsed.tokens !== "object" || Array.isArray(parsed.tokens)) {
    throw new Error("auth.json is missing tokens.")
  }

  for (const field of ["id_token", "access_token", "refresh_token", "account_id"]) {
    if (typeof parsed.tokens[field] !== "string" || !parsed.tokens[field].trim()) {
      throw new Error(`auth.json is missing tokens.${field}.`)
    }
  }

  return {
    authJson: raw,
    accountId: parsed.tokens.account_id.trim(),
  }
}

export async function runCodexAuthUpload(options, deps = {}) {
  const stdout = deps.stdout ?? ((line) => console.log(line))
  const stderr = deps.stderr ?? ((line) => console.error(line))
  const fetchImpl = deps.fetch ?? fetch

  validateOptions(options)

  const credentialLabel = options.credentialName || options.credentialId || "New Codex account"
  const profileDir = expandHome(options.profileDir || defaultProfileDir(credentialLabel))
  const authJsonPath = expandHome(options.authJsonPath || path.join(profileDir, "auth.json"))

  if (!options.authJsonPath) {
    await mkdir(profileDir, { recursive: true })
    stdout(`Codex profile: ${profileDir}`)
    stdout("Opening Codex device login. Complete the browser flow, then return here.")
    await (deps.spawnCodexLogin ?? spawnCodexLogin)(profileDir)
  }

  const rawAuthJson = await readFile(authJsonPath, "utf8")
  const validated = validateCodexAuthJson(rawAuthJson)

  stdout(options.credentialId ? `Credential: ${credentialLabel} (${options.credentialId})` : `Credential: ${credentialLabel}`)
  stdout(`Codex account: ${validated.accountId}`)

  if (!options.yes) {
    const confirmed = await (deps.promptConfirm ?? promptConfirm)(
      `Upload this Codex login to ${credentialLabel}? Type yes to continue: `,
    )
    if (!confirmed) {
      throw new Error("Upload cancelled.")
    }
  }

  if (options.dryRun) {
    stdout("Dry run: auth.json was validated, upload skipped.")
    return {
      ok: true,
      credentialId: options.credentialId,
      credentialName: credentialLabel,
      accountId: validated.accountId,
      dryRun: true,
    }
  }

  const response = await fetchImpl(options.uploadUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      authJson: validated.authJson,
    }),
  })

  if (!response.ok) {
    const body = await safeReadResponseText(response)
    throw new Error(`Upload failed with HTTP ${response.status}${body ? `: ${body}` : ""}`)
  }

  const payload = await response.json()
  stdout(`Uploaded Codex auth for ${payload.credentialName ?? credentialLabel}.`)
  if (payload.accountId) {
    stdout(`Server confirmed account: ${payload.accountId}`)
  }
  return payload
}

async function spawnCodexLogin(profileDir) {
  await new Promise((resolve, reject) => {
    const child = spawn("codex", ["-c", CONFIG_OVERRIDE, "login", "--device-auth"], {
      env: {
        ...process.env,
        CODEX_HOME: profileDir,
      },
      stdio: "inherit",
    })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`codex login failed with exit code ${code}.`))
    })
  })
}

async function promptConfirm(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  try {
    const answer = await rl.question(question)
    return answer.trim().toLowerCase() === "yes"
  } finally {
    rl.close()
  }
}

function validateOptions(options) {
  if (!options.uploadUrl) {
    throw new UsageError(`Missing --upload-url.\n\n${usage()}`)
  }
  try {
    const parsed = new URL(options.uploadUrl)
    if (parsed.protocol !== "https:" && parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      throw new Error("invalid protocol")
    }
  } catch {
    throw new UsageError(`Invalid --upload-url.\n\n${usage()}`)
  }
}

function expandHome(value) {
  if (!value.startsWith("~")) {
    return value
  }
  return path.join(homedir(), value.slice(1))
}

function defaultProfileDir(label) {
  const slug = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "codex"
  return path.join(homedir(), ".veslo", "codex-auth", slug)
}

async function safeReadResponseText(response) {
  try {
    return (await response.text()).trim().slice(0, 500)
  } catch {
    return ""
  }
}

function usage() {
  return [
    "Usage:",
    "  node scripts/admin/codex-auth-upload.mjs --upload-url <url> [--credential-id <id>] [--credential-name <name>] [--profile-dir <dir>] [--yes]",
    "",
    "Options:",
    "  --auth-json-path <path>  Use an existing auth.json instead of running codex login.",
    "  --profile-dir <dir>      Store Codex login files in this directory. Defaults to ~/.veslo/codex-auth/<credential>.",
    "  --dry-run                Validate auth.json but do not upload.",
    "  --yes, -y                Skip confirmation prompt.",
  ].join("\n")
}

class UsageError extends Error {}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runCodexAuthUpload(parseArgs(process.argv.slice(2))).catch((error) => {
    const isUsageError = error instanceof UsageError
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = isUsageError ? 64 : 1
  })
}
