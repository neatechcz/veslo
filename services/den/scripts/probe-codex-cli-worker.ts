import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

type ProbeSummary = {
  ok: boolean
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  stdout: string
  stderr: string
  finalMessage: string
}

const summary: ProbeSummary = {
  ok: false,
  exitCode: null,
  signal: null,
  timedOut: false,
  stdout: "",
  stderr: "",
  finalMessage: "",
}

const command = process.env.MANAGED_AI_CODEX_COMMAND?.trim() || "codex"
const model = process.env.MANAGED_AI_CODEX_TEST_MODEL?.trim() || ""
const prompt = process.env.MANAGED_AI_CODEX_TEST_PROMPT?.trim() || "Reply with exactly one word: ok"
const codexHome = process.env.MANAGED_AI_CODEX_HOME?.trim() || ""
const timeoutMs = Number.parseInt(process.env.MANAGED_AI_CODEX_TIMEOUT_MS ?? "120000", 10)

if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  summary.stderr = "MANAGED_AI_CODEX_TIMEOUT_MS must be a positive integer"
  printSummary(summary)
  process.exitCode = 1
} else if (!codexHome) {
  summary.stderr = "MANAGED_AI_CODEX_HOME is required"
  printSummary(summary)
  process.exitCode = 1
} else {
  await main()
}

async function main() {
  const scratchDir = await mkdtemp(path.join(tmpdir(), "veslo-codex-worker-"))
  const outputFile = path.join(scratchDir, "last-message.txt")

  try {
    const args = [
      "--ask-for-approval",
      "never",
      "exec",
      "--cd",
      scratchDir,
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--output-last-message",
      outputFile,
    ]

    if (model) {
      args.push("--model", model)
    }

    args.push(prompt)

    const result = await runCodex(command, args, timeoutMs, codexHome, scratchDir)
    summary.exitCode = result.exitCode
    summary.signal = result.signal
    summary.timedOut = result.timedOut
    summary.stdout = tail(result.stdout)
    summary.stderr = tail(result.stderr)
    summary.finalMessage = tail(await readTextFile(outputFile))
    summary.ok = result.exitCode === 0 && !result.timedOut && summary.finalMessage.trim().length > 0
    printSummary(summary)

    if (!summary.ok) {
      process.exitCode = 1
    }
  } catch (error) {
    summary.stderr = tail(errorToString(error))
    printSummary(summary)
    process.exitCode = 1
  } finally {
    await rm(scratchDir, { recursive: true, force: true })
  }
}

function runCodex(
  commandName: string,
  args: string[],
  timeoutMsValue: number,
  codexHomeDir: string,
  cwd: string,
) {
  return new Promise<{
    exitCode: number | null
    signal: NodeJS.Signals | null
    timedOut: boolean
    stdout: string
    stderr: string
  }>((resolve, reject) => {
    const childEnv = buildCodexChildEnv(codexHomeDir)
    const child = spawn(commandName, args, {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false
    let killTimer: NodeJS.Timeout | undefined

    const timeoutTimer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      killTimer = setTimeout(() => {
        child.kill("SIGKILL")
      }, 5000)
      killTimer.unref()
    }, timeoutMsValue)
    timeoutTimer.unref()

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", (error) => {
      clearTimeout(timeoutTimer)
      if (killTimer) {
        clearTimeout(killTimer)
      }
      reject(error)
    })
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeoutTimer)
      if (killTimer) {
        clearTimeout(killTimer)
      }
      resolve({ exitCode, signal, timedOut, stdout, stderr })
    })
  })
}

function buildCodexChildEnv(codexHomeDir: string | undefined) {
  const env: NodeJS.ProcessEnv = {}
  const allowedKeys = [
    "PATH",
    "HOME",
    "USER",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "ComSpec",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
  ] as const

  for (const key of allowedKeys) {
    const value = process.env[key]
    if (value) {
      env[key] = value
    }
  }

  delete env.OPENAI_API_KEY
  delete env.ANTHROPIC_API_KEY
  delete env.CODEX_HOME

  if (codexHomeDir) {
    env.CODEX_HOME = codexHomeDir
  }

  return env
}

async function readTextFile(filePath: string) {
  try {
    return await readFile(filePath, "utf8")
  } catch {
    return ""
  }
}

function tail(text: string, maxLength = 2000) {
  if (text.length <= maxLength) {
    return text
  }

  return text.slice(text.length - maxLength)
}

function printSummary(value: ProbeSummary) {
  console.log(JSON.stringify(value, null, 2))
}

function errorToString(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}
