import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type JsonRpcId = number;

type JsonRpcError = {
  code: number;
  message: string;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type LiveFeedbackYouTrackConfig = {
  projectKey: string;
  command: string;
  args: string[];
  wireProtocol: "line" | "content-length";
  mcpTimeoutMs: number;
  pollTimeoutMs: number;
  pollIntervalMs: number;
};

export type YouTrackIssue = {
  id: string;
  summary: string | null;
  url: string | null;
  description?: string | null;
};

export type LiveFeedbackArtifact = {
  runId: string;
  title: string;
  expectedSummary: string;
  description: string;
  submittedAt: string;
  denAuth: {
    denApiBase: string | null;
    orgId: string | null;
    userEmail: string | null;
  } | null;
  youtrackIssue?: YouTrackIssue;
};

type McpToolResultEnvelope = {
  structuredContent?: unknown;
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readPositiveNumber(raw: string | undefined, fallback: number, label: string) {
  const parsed = Number(raw ?? String(fallback));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return parsed;
}

function readWireProtocol(raw: string | undefined): LiveFeedbackYouTrackConfig["wireProtocol"] {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return "line";
  if (normalized === "line" || normalized === "content-length") return normalized;
  throw new Error("E2E_YOUTRACK_MCP_WIRE_PROTOCOL must be either line or content-length.");
}

function encodeMessage(message: Record<string, unknown>, wireProtocol: LiveFeedbackYouTrackConfig["wireProtocol"]) {
  const payload = JSON.stringify(message);
  if (wireProtocol === "line") return `${payload}\n`;
  return `Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`;
}

function parseLineJsonRpcResponses(buffer: string) {
  const messages: JsonRpcResponse[] = [];
  const lines = buffer.split(/\r?\n/);
  const remaining = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    messages.push(JSON.parse(line) as JsonRpcResponse);
  }

  return { messages, remaining };
}

function parseContentLengthJsonRpcResponses(buffer: string) {
  const messages: JsonRpcResponse[] = [];
  let remaining = buffer;

  while (remaining.length > 0) {
    const headerEnd = remaining.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const header = remaining.slice(0, headerEnd);
    const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
    if (!lengthMatch) {
      throw new Error("MCP response is missing Content-Length header.");
    }

    const contentLength = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + contentLength;
    if (remaining.length < bodyEnd) break;

    messages.push(JSON.parse(remaining.slice(bodyStart, bodyEnd)) as JsonRpcResponse);
    remaining = remaining.slice(bodyEnd);
  }

  return { messages, remaining };
}

function parseJsonRpcResponses(buffer: string, wireProtocol: LiveFeedbackYouTrackConfig["wireProtocol"]) {
  return wireProtocol === "line"
    ? parseLineJsonRpcResponses(buffer)
    : parseContentLengthJsonRpcResponses(buffer);
}

function normalizeMcpContent(result: unknown): unknown {
  if (!isObject(result)) return result;
  const envelope = result as McpToolResultEnvelope;
  if (envelope.structuredContent !== undefined) return envelope.structuredContent;

  const firstText = envelope.content?.find((entry) => entry.type === "text" && typeof entry.text === "string")?.text;
  if (!firstText) return result;

  try {
    return JSON.parse(firstText);
  } catch {
    return firstText;
  }
}

function readIssue(candidate: unknown): YouTrackIssue | null {
  if (!isObject(candidate)) return null;

  const id = readString(candidate.issueId) ?? readString(candidate.id);
  if (!id) return null;

  const issue: YouTrackIssue = {
    id,
    summary: readString(candidate.summary),
    url: readString(candidate.issueUrl) ?? readString(candidate.url),
  };
  const description = readString(candidate.description);
  if (description) issue.description = description;
  return issue;
}

export function parseMcpArgs(raw: string | undefined) {
  if (!raw || raw.trim().length === 0) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`E2E_YOUTRACK_MCP_ARGS must be a JSON string array. ${message}`);
  }

  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error("E2E_YOUTRACK_MCP_ARGS must be a JSON string array.");
  }

  return parsed.map((entry) => entry.trim()).filter(Boolean);
}

export function buildYouTrackFeedbackQuery(projectKey: string, title: string) {
  const escapedTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `project: ${projectKey} "${escapedTitle}"`;
}

export function extractYouTrackIssues(result: unknown): YouTrackIssue[] {
  const content = normalizeMcpContent(result);
  if (Array.isArray(content)) {
    return content.flatMap((entry) => {
      const issue = readIssue(entry);
      return issue ? [issue] : [];
    });
  }

  if (!isObject(content)) return [];

  for (const key of ["issuesPage", "items", "issues"]) {
    const page = content[key];
    if (Array.isArray(page)) {
      return page.flatMap((entry) => {
        const issue = readIssue(entry);
        return issue ? [issue] : [];
      });
    }
  }

  const issue = readIssue(content);
  return issue ? [issue] : [];
}

export function resolveLiveFeedbackYouTrackConfig(
  env: NodeJS.ProcessEnv = process.env,
): LiveFeedbackYouTrackConfig {
  const defaultCommand = join(env.HOME?.trim() || homedir(), ".config", "youtrack-mcp", "run-remote.sh");

  return {
    projectKey: env.E2E_YOUTRACK_PROJECT_KEY?.trim() || env.YOUTRACK_PROJECT_KEY?.trim() || "VSLO",
    command: env.E2E_YOUTRACK_MCP_COMMAND?.trim() || env.YOUTRACK_MCP_COMMAND?.trim() || defaultCommand,
    args: parseMcpArgs(env.E2E_YOUTRACK_MCP_ARGS ?? env.YOUTRACK_MCP_ARGS),
    wireProtocol: readWireProtocol(env.E2E_YOUTRACK_MCP_WIRE_PROTOCOL ?? env.YOUTRACK_MCP_WIRE_PROTOCOL),
    mcpTimeoutMs: readPositiveNumber(env.E2E_YOUTRACK_MCP_TIMEOUT_MS, 20_000, "E2E_YOUTRACK_MCP_TIMEOUT_MS"),
    pollTimeoutMs: readPositiveNumber(env.E2E_YOUTRACK_POLL_TIMEOUT_MS, 180_000, "E2E_YOUTRACK_POLL_TIMEOUT_MS"),
    pollIntervalMs: readPositiveNumber(env.E2E_YOUTRACK_POLL_INTERVAL_MS, 5_000, "E2E_YOUTRACK_POLL_INTERVAL_MS"),
  };
}

export function assertMcpCommandAvailable(config: Pick<LiveFeedbackYouTrackConfig, "command">) {
  if (!existsSync(config.command)) {
    throw new Error(
      `YouTrack MCP command not found at ${config.command}. Set E2E_YOUTRACK_MCP_COMMAND for the live feedback smoke.`,
    );
  }
}

export function createMcpStdioClient(
  config: Pick<LiveFeedbackYouTrackConfig, "command" | "args" | "wireProtocol" | "mcpTimeoutMs">,
) {
  return {
    async callTool(name: string, args: Record<string, unknown>) {
      const child = spawn(config.command, config.args, {
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let nextRequestId = 1;
      let stdoutBuffer = "";
      let stderrOutput = "";
      const pending = new Map<JsonRpcId, PendingRequest>();

      function cleanup() {
        for (const request of pending.values()) clearTimeout(request.timer);
        pending.clear();
        child.stdout.removeAllListeners();
        child.stderr.removeAllListeners();
      }

      function rejectPendingRequests(reason: string) {
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error(reason));
        }
        pending.clear();
      }

      function sendMessage(message: Record<string, unknown>) {
        child.stdin.write(encodeMessage(message, config.wireProtocol), "utf8");
      }

      function request(method: string, params?: unknown) {
        const id = nextRequestId;
        nextRequestId += 1;

        return new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`MCP ${method} request timed out after ${config.mcpTimeoutMs}ms.`));
          }, config.mcpTimeoutMs);

          pending.set(id, { resolve, reject, timer });
          sendMessage({ jsonrpc: "2.0", id, method, params });
        });
      }

      function notify(method: string, params?: unknown) {
        sendMessage({ jsonrpc: "2.0", method, params });
      }

      child.stdout.on("data", (chunk: Buffer | string) => {
        try {
          stdoutBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          const { messages, remaining } = parseJsonRpcResponses(stdoutBuffer, config.wireProtocol);
          stdoutBuffer = remaining;

          for (const message of messages) {
            const requestState = typeof message.id === "number" ? pending.get(message.id) : null;
            if (!requestState) continue;

            clearTimeout(requestState.timer);
            pending.delete(message.id);

            if (message.error) {
              requestState.reject(new Error(`MCP ${message.error.code}: ${message.error.message}`));
            } else {
              requestState.resolve(message.result);
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const stderrSuffix = stderrOutput.trim() ? ` stderr: ${stderrOutput.trim()}` : "";
          rejectPendingRequests(`Invalid MCP stdout response: ${message}.${stderrSuffix}`);
          child.stdin.end();
          child.kill();
        }
      });

      child.stderr.on("data", (chunk: Buffer | string) => {
        stderrOutput += String(chunk);
      });

      child.on("error", (error) => {
        rejectPendingRequests(`Failed to start MCP process: ${error.message}`);
      });

      child.on("exit", (code, signal) => {
        if (pending.size === 0) return;
        const stderrSuffix = stderrOutput.trim() ? ` stderr: ${stderrOutput.trim()}` : "";
        rejectPendingRequests(`MCP process exited before completing the request (code=${code}, signal=${signal}).${stderrSuffix}`);
      });

      try {
        await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "veslo-feedback-youtrack-live-e2e",
            version: "0.0.0",
          },
        });
        notify("notifications/initialized");
        const result = await request("tools/call", { name, arguments: args });
        child.stdin.end();
        child.kill();
        cleanup();
        return result;
      } catch (error) {
        child.stdin.end();
        child.kill();
        cleanup();
        throw error;
      }
    },
  };
}

export async function searchYouTrackFeedbackIssue(config: LiveFeedbackYouTrackConfig, title: string) {
  const client = createMcpStdioClient(config);
  const result = await client.callTool("search_issues", {
    query: buildYouTrackFeedbackQuery(config.projectKey, title),
    limit: 10,
    customFieldsToReturn: [],
  });

  const expectedSummary = `[Bug] ${title}`;
  return extractYouTrackIssues(result).find((issue) => issue.summary === expectedSummary || issue.summary?.includes(title)) ?? null;
}

export async function waitForYouTrackFeedbackIssue(config: LiveFeedbackYouTrackConfig, title: string) {
  const deadline = Date.now() + config.pollTimeoutMs;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    try {
      const issue = await searchYouTrackFeedbackIssue(config, title);
      if (issue) return issue;
      lastError = null;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  }

  const suffix = lastError ? ` Last MCP error: ${lastError}` : "";
  throw new Error(`Timed out waiting for a YouTrack issue for feedback title "${title}".${suffix}`);
}

export function writeLiveFeedbackArtifact(artifact: LiveFeedbackArtifact) {
  const outputDir = join(process.cwd(), ".tmp-live-feedback-youtrack");
  mkdirSync(outputDir, { recursive: true });
  const outputPath = join(outputDir, "latest.json");
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return outputPath;
}
