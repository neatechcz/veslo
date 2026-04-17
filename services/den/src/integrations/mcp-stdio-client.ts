import { spawn } from "node:child_process"

type JsonRpcId = number

type JsonRpcError = {
  code: number
  message: string
  data?: unknown
}

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: JsonRpcId
  result?: unknown
  error?: JsonRpcError
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type McpStdioClientConfig = {
  command: string
  args?: string[]
  timeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
}

function encodeMessage(message: Record<string, unknown>) {
  const payload = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`
}

function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function parseJsonRpcResponses(buffer: string) {
  const messages: JsonRpcResponse[] = []
  let remaining = buffer

  while (remaining.length > 0) {
    const headerEnd = remaining.indexOf("\r\n\r\n")
    if (headerEnd === -1) {
      break
    }

    const header = remaining.slice(0, headerEnd)
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header)
    if (!lengthMatch) {
      throw new Error("MCP response is missing Content-Length header.")
    }

    const contentLength = Number(lengthMatch[1])
    const bodyStart = headerEnd + 4
    const bodyEnd = bodyStart + contentLength
    if (remaining.length < bodyEnd) {
      break
    }

    const body = remaining.slice(bodyStart, bodyEnd)
    const parsed = JSON.parse(body) as JsonRpcResponse
    messages.push(parsed)
    remaining = remaining.slice(bodyEnd)
  }

  return {
    messages,
    remaining,
  }
}

export function createMcpStdioClient(config: McpStdioClientConfig) {
  const timeoutMs = config.timeoutMs ?? 20_000

  return {
    async callTool(name: string, args: Record<string, unknown>) {
      const child = spawn(config.command, config.args ?? [], {
        cwd: config.cwd,
        env: {
          ...process.env,
          ...config.env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      })

      let nextRequestId = 1
      let stdoutBuffer = ""
      let stderrOutput = ""
      const pending = new Map<JsonRpcId, PendingRequest>()

      function cleanup() {
        for (const request of pending.values()) {
          clearTimeout(request.timer)
        }
        pending.clear()
        child.stdout.removeAllListeners()
        child.stderr.removeAllListeners()
      }

      function rejectPendingRequests(reason: string) {
        for (const request of pending.values()) {
          clearTimeout(request.timer)
          request.reject(new Error(reason))
        }
        pending.clear()
      }

      function sendMessage(message: Record<string, unknown>) {
        child.stdin.write(encodeMessage(message), "utf8")
      }

      function request(method: string, params?: unknown) {
        const id = nextRequestId
        nextRequestId += 1

        return new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id)
            reject(new Error(`MCP ${method} request timed out after ${timeoutMs}ms.`))
          }, timeoutMs)

          pending.set(id, { resolve, reject, timer })
          sendMessage({
            jsonrpc: "2.0",
            id,
            method,
            params,
          })
        })
      }

      function notify(method: string, params?: unknown) {
        sendMessage({
          jsonrpc: "2.0",
          method,
          params,
        })
      }

      child.stdout.on("data", (chunk: Buffer | string) => {
        try {
          stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
          const { messages, remaining } = parseJsonRpcResponses(stdoutBuffer)
          stdoutBuffer = remaining

          for (const message of messages) {
            if (!isObject(message) || typeof message.id !== "number") {
              continue
            }

            const pendingRequest = pending.get(message.id)
            if (!pendingRequest) {
              continue
            }

            clearTimeout(pendingRequest.timer)
            pending.delete(message.id)

            if (message.error) {
              pendingRequest.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`))
              continue
            }

            pendingRequest.resolve(message.result)
          }
        } catch (error) {
          const stderrSuffix = stderrOutput.trim().length > 0 ? ` stderr: ${stderrOutput.trim()}` : ""
          rejectPendingRequests(`Invalid MCP stdout response: ${toErrorMessage(error)}.${stderrSuffix}`)
          child.stdin.end()
          child.kill()
        }
      })

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrOutput += String(chunk)
      })

      child.on("error", (error) => {
        rejectPendingRequests(`Failed to start MCP process: ${toErrorMessage(error)}`)
      })

      child.on("exit", (code, signal) => {
        if (pending.size === 0) {
          return
        }

        const stderrSuffix = stderrOutput.trim().length > 0 ? ` stderr: ${stderrOutput.trim()}` : ""
        rejectPendingRequests(`MCP process exited before completing the request (code=${code}, signal=${signal}).${stderrSuffix}`)
      })

      try {
        await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "den-feedback-projector",
            version: "0.0.0",
          },
        })
        notify("notifications/initialized")
        const result = await request("tools/call", {
          name,
          arguments: args,
        })
        child.stdin.end()
        child.kill()
        cleanup()
        return result
      } catch (error) {
        child.stdin.end()
        child.kill()
        cleanup()
        throw error
      }
    },
  }
}
