import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"

import {
  ProviderTransportError,
  type CodexChatCompletionsTransportInput,
  type CodexOAuthProviderTransport,
  type ProviderTransportResponse,
} from "./transport.js"

export type CodexCliWorkerRunInput = {
  prompt: string
  model: string
}

export type CodexCliWorkerRunResult = {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  finalMessage: string
  stdout: string
  stderr: string
}

export type CodexCliWorkerTransportDeps = {
  spawnCodex?: (input: CodexCliWorkerRunInput) => Promise<CodexCliWorkerRunResult>
  command?: string
  codexHome?: string
  allowHostHome?: boolean
  authJson?: string
  workDir?: string
  timeoutMs?: number
  now?: () => Date
  randomId?: () => string
}

export class CodexCliWorkerTransport implements CodexOAuthProviderTransport {
  private readonly spawnCodex: (input: CodexCliWorkerRunInput) => Promise<CodexCliWorkerRunResult>
  private readonly command: string
  private readonly codexHome: string
  private readonly allowHostHome: boolean
  private readonly authJson: string
  private readonly workDir: string
  private readonly timeoutMs: number
  private readonly now: () => Date
  private readonly randomId: () => string

  constructor(deps: CodexCliWorkerTransportDeps = {}) {
    this.command = deps.command?.trim() || process.env.AI_GATEWAY_CODEX_COMMAND?.trim() || "codex"
    this.codexHome = deps.codexHome?.trim() || process.env.AI_GATEWAY_CODEX_HOME?.trim() || ""
    this.allowHostHome = deps.allowHostHome ?? process.env.AI_GATEWAY_CODEX_ALLOW_HOST_HOME?.trim() === "1"
    this.authJson = deps.authJson?.trim() || process.env.AI_GATEWAY_CODEX_AUTH_JSON?.trim() || ""
    this.workDir = deps.workDir?.trim() || process.env.AI_GATEWAY_CODEX_WORKDIR?.trim() || tmpdir()
    this.timeoutMs = deps.timeoutMs ?? parseTimeoutMs(process.env.AI_GATEWAY_CODEX_TIMEOUT_MS)
    this.now = deps.now ?? (() => new Date())
    this.randomId = deps.randomId ?? randomUUID
    this.spawnCodex = deps.spawnCodex ?? ((input) => this.runCodexCli(input))
  }

  async chatCompletions(input: CodexChatCompletionsTransportInput): Promise<ProviderTransportResponse> {
    const body = getRecord(input.body)
    if (!body) {
      throw new ProviderTransportError("codex_invalid_request_body", {
        statusCode: 400,
        code: "invalid_request_body",
      })
    }

    if (body.stream === true) {
      throw new ProviderTransportError("codex_streaming_not_supported", {
        statusCode: 400,
        code: "streaming_not_supported",
      })
    }

    const model = getString(body, "model") ?? "unknown"
    const prompt = formatPrompt(readMessages(body.messages))
    const result = await this.spawnCodex({ prompt, model })
    if (result.exitCode !== 0 || result.timedOut || !result.finalMessage.trim()) {
      throw new ProviderTransportError("codex_worker_failed", {
        statusCode: 502,
        code: result.timedOut ? "codex_worker_timeout" : "codex_worker_failed",
        body: {
          error: "codex_worker_failed",
          timedOut: result.timedOut,
          exitCode: result.exitCode,
        },
      })
    }

    const created = Math.floor(this.now().getTime() / 1000)
    return {
      status: 200,
      headers: { "content-type": "application/json" },
      body: {
        id: `chatcmpl_${this.randomId()}`,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: result.finalMessage,
            },
            finish_reason: "stop",
          },
        ],
        usage: null,
      },
    }
  }

  private async runCodexCli(input: CodexCliWorkerRunInput): Promise<CodexCliWorkerRunResult> {
    if (!this.codexHome) {
      throw new ProviderTransportError("codex_worker_home_required", {
        statusCode: 503,
        code: "codex_worker_home_required",
      })
    }

    if (isHostDefaultCodexHome(this.codexHome) && !this.allowHostHome) {
      throw new ProviderTransportError("codex_worker_home_is_host_default", {
        statusCode: 503,
        code: "codex_worker_home_is_host_default",
      })
    }

    await materializeCodexAuthJson({
      codexHome: this.codexHome,
      authJson: this.authJson,
    })

    const scratchDir = await mkdtemp(path.join(this.workDir, "veslo-codex-worker-"))
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

      if (input.model) {
        args.push("--model", input.model)
      }

      args.push(input.prompt)
      const result = await runProcess({
        command: this.command,
        args,
        cwd: scratchDir,
        codexHome: this.codexHome,
        timeoutMs: this.timeoutMs,
      })
      const finalMessage = result.exitCode === 0 ? await readFile(outputFile, "utf8").catch(() => "") : ""

      return {
        ...result,
        finalMessage,
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true })
    }
  }
}

export async function materializeCodexAuthJson(input: {
  codexHome: string
  authJson: string
}) {
  const authJson = input.authJson.trim()
  if (!authJson) {
    return false
  }

  try {
    const parsed = JSON.parse(authJson)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("codex_worker_auth_json_invalid")
    }
  } catch {
    throw new ProviderTransportError("codex_worker_auth_json_invalid", {
      statusCode: 503,
      code: "codex_worker_auth_json_invalid",
    })
  }

  await mkdir(input.codexHome, { recursive: true, mode: 0o700 })
  const authPath = path.join(input.codexHome, "auth.json")
  await writeFile(authPath, `${authJson}\n`, { mode: 0o600 })
  await chmod(authPath, 0o600)
  return true
}

function parseTimeoutMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "120000", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000
}

function formatPrompt(messages: Array<{ role: string; content: string }>): string {
  return messages.map((message) => `${message.role}: ${message.content}`).join("\n\n")
}

function readMessages(value: unknown): Array<{ role: string; content: string }> {
  if (!Array.isArray(value)) {
    return []
  }

  const messages: Array<{ role: string; content: string }> = []
  for (const entry of value) {
    const record = getRecord(entry)
    if (!record) {
      continue
    }

    const role = getString(record, "role") ?? "user"
    const content = readMessageContent(record.content)
    if (!content) {
      continue
    }
    messages.push({ role, content })
  }
  return messages
}

function readMessageContent(value: unknown): string {
  if (typeof value === "string") {
    return value
  }

  if (!Array.isArray(value)) {
    return ""
  }

  return value
    .map((part) => {
      const record = getRecord(part)
      const text = getString(record, "text")
      if (text) {
        return text
      }
      return getString(record, "content") ?? ""
    })
    .filter(Boolean)
    .join("\n")
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null
  }

  return value as Record<string, unknown>
}

function getString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function isHostDefaultCodexHome(codexHome: string): boolean {
  const normalizedCodexHome = path.resolve(codexHome)
  const defaultHome = path.join(homedir(), ".codex")
  return normalizedCodexHome === path.resolve(defaultHome)
}

function runProcess(input: {
  command: string
  args: string[]
  cwd: string
  codexHome: string
  timeoutMs: number
}): Promise<Omit<CodexCliWorkerRunResult, "finalMessage">> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        CODEX_HOME: input.codexHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    let timedOut = false

    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
      setTimeout(() => {
        if (!settled) {
          child.kill("SIGKILL")
        }
      }, 5_000).unref()
    }, input.timeoutMs)
    timeout.unref()

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8")
    })

    child.on("error", (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({
        exitCode: 1,
        signal: null,
        timedOut,
        stdout,
        stderr: `${stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
      })
    })

    child.on("close", (exitCode, signal) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
      })
    })
  })
}
