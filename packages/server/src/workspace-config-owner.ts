import { readFile, rm, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { isAbsolute, join, resolve } from "node:path";

import { listCommands, upsertCommand } from "./commands.js";
import { ApiError } from "./errors.js";
import { parseFrontmatter } from "./frontmatter.js";
import { updateJsoncTopLevel, writeJsoncFile } from "./jsonc.js";
import {
  isAuthorizedRoot,
  normalizeOpencodeDirectory,
  readTextPreview,
} from "./route-helpers.js";
import { listSkills, upsertSkill } from "./skills.js";
import { workspaceSkillsRoot } from "./skill-roots.js";
import type { WorkspaceInfo } from "./types.js";
import { ensureDir, exists } from "./utils.js";
import {
  opencodeConfigPath,
  projectCommandsDir,
  vesloConfigPath,
} from "./workspace-files.js";

const OPENCODE_JSON_DEFAULT_RESPONSE_MAX_BYTES = 1024 * 1024;
const OPENCODE_JSON_FETCH_DEFAULT_TIMEOUT_MS = 5_000;

export type WorkspaceConfigOwnerDependencies = {
  readOpencodeConfig: (workspaceRoot: string) => Promise<Record<string, unknown>>;
  redactSensitiveConfig: <T>(value: T) => T;
};

export type WorkspaceExportPayload = {
  workspaceId: string;
  exportedAt: number;
  opencode: Record<string, unknown>;
  veslo: Record<string, unknown>;
  skills: Array<{ name: string; description?: string; content: string }>;
  commands: Array<{ name: string; description?: string; template: string }>;
};

function parseInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveOpenCodeJsonFetchTimeoutMs(): number {
  const parsed = parseInteger(process.env.VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS);
  if (parsed && parsed > 0) {
    return clampNumber(parsed, 100, 60_000);
  }
  return OPENCODE_JSON_FETCH_DEFAULT_TIMEOUT_MS;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  return name === "AbortError" || name === "TimeoutError";
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(502, "upstream_payload_too_large", "Upstream response body exceeds local parsing limit", {
      maxBytes,
      size: contentLength,
    });
  }

  const preview = await readTextPreview(response.body, maxBytes);
  if (preview.truncated) {
    throw new ApiError(502, "upstream_payload_too_large", "Upstream response body exceeds local parsing limit", {
      maxBytes,
    });
  }
  return preview.text;
}

export async function readVesloConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const path = vesloConfigPath(workspaceRoot);
  if (!(await exists(path))) return {};
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse veslo.json");
  }
}

export function resolveOpencodeDirectory(workspace: WorkspaceInfo): string | null {
  const explicit = workspace.directory?.trim() ?? "";
  if (explicit) return normalizeOpencodeDirectory(explicit);
  if (workspace.workspaceType === "local") return normalizeOpencodeDirectory(workspace.path);
  return null;
}

export function normalizeConversationReadDirectoryRequest(
  workspace: WorkspaceInfo,
  requestedRaw: string | null,
  fallback: string | null,
): string {
  const requested = requestedRaw?.trim() ?? "";
  if (!requested) return "";

  const workspaceRoot = fallback?.trim() || workspace.directory?.trim() || workspace.path?.trim() || "";
  const slashRequested = requested.replace(/\\/g, "/");
  if (slashRequested === "/workspace" || slashRequested === "workspace") {
    return workspaceRoot;
  }
  if (slashRequested.startsWith("/workspace/") || slashRequested.startsWith("workspace/")) {
    const relativePath = slashRequested.replace(/^\/?workspace\/+/, "");
    return workspaceRoot ? join(workspaceRoot, relativePath) : requested;
  }

  if (process.platform === "win32") {
    const wslMount = slashRequested.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
    if (wslMount) {
      const drive = wslMount[1]?.toUpperCase();
      const rest = wslMount[2]?.trim() ?? "";
      return drive ? (rest ? `${drive}:/${rest}` : `${drive}:/`) : requested;
    }
  }

  return requested;
}

export async function resolveConversationReadDirectory(
  workspace: WorkspaceInfo,
  requestedRaw: string | null,
): Promise<string | null> {
  const fallback = resolveOpencodeDirectory(workspace);
  const requested = normalizeConversationReadDirectoryRequest(workspace, requestedRaw, fallback);
  if (!requested) return fallback;

  if (!isAbsolute(requested)) {
    throw new ApiError(400, "invalid_directory", "Conversation directory must be absolute");
  }

  const directory = normalizeOpencodeDirectory(resolve(requested));
  const allowedRoots = [
    workspace.path,
    fallback,
  ].filter((value): value is string => Boolean(value?.trim()));
  const authorized = await isAuthorizedRoot(directory, allowedRoots);
  if (!authorized) {
    throw new ApiError(403, "directory_unauthorized", "Conversation directory is outside this workspace");
  }
  return directory;
}

export function buildOpencodeReloadUrl(baseUrl: string, directory?: string | null): string {
  try {
    const url = new URL(baseUrl);
    // Desktop workspaces use the orchestrator's per-workspace OpenCode mount.
    // Reload must travel through that mount too; replacing the pathname with a
    // root-level endpoint would target the orchestrator itself rather than the
    // workspace engine.
    const normalizedPathname = url.pathname.replace(/\/+$/, "");
    url.pathname = /^\/workspace\/[^/]+\/opencode$/i.test(normalizedPathname)
      ? `${normalizedPathname}/instance/dispose`
      : "/instance/dispose";
    url.search = "";
    if (directory) {
      url.searchParams.set("directory", directory);
    }
    return url.toString();
  } catch {
    throw new ApiError(400, "opencode_url_invalid", "OpenCode base URL is invalid");
  }
}

export function buildOpencodeAuthHeader(workspace: WorkspaceInfo): string | null {
  const username = workspace.opencodeUsername?.trim() ?? "";
  const password = workspace.opencodePassword?.trim() ?? "";
  if (!username || !password) return null;
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

export function parseOpencodeErrorBody(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

export async function reloadOpencodeEngine(workspace: WorkspaceInfo): Promise<void> {
  const baseUrl = workspace.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const directory = resolveOpencodeDirectory(workspace);
  const targetUrl = buildOpencodeReloadUrl(baseUrl, directory);
  const headers: Record<string, string> = {};
  const auth = buildOpencodeAuthHeader(workspace);
  if (auth) headers.Authorization = auth;

  const timeoutMs = resolveOpenCodeJsonFetchTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timeout === "object" && timeout && "unref" in timeout) {
    (timeout as { unref?: () => void }).unref?.();
  }

  try {
    const response = await fetch(targetUrl, { method: "POST", headers, signal: controller.signal });
    if (response.ok) return;
    const body = parseOpencodeErrorBody(await readResponseTextWithLimit(response, OPENCODE_JSON_DEFAULT_RESPONSE_MAX_BYTES));
    throw new ApiError(502, "opencode_reload_failed", "OpenCode reload failed", {
      status: response.status,
      body,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut || isAbortError(error)) {
      throw new ApiError(502, "opencode_request_timeout", "OpenCode request timed out", {
        path: "/instance/dispose",
        timeoutMs,
      });
    }
    throw new ApiError(502, "opencode_reload_failed", "OpenCode reload failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function writeVesloConfig(
  workspaceRoot: string,
  payload: Record<string, unknown>,
  merge: boolean,
): Promise<void> {
  const path = vesloConfigPath(workspaceRoot);
  const next = merge ? { ...(await readVesloConfig(workspaceRoot)), ...payload } : payload;
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

async function exportWorkspace(
  workspace: WorkspaceInfo,
  dependencies: WorkspaceConfigOwnerDependencies,
): Promise<WorkspaceExportPayload> {
  const opencode = dependencies.redactSensitiveConfig(await dependencies.readOpencodeConfig(workspace.path));
  const veslo = dependencies.redactSensitiveConfig(await readVesloConfig(workspace.path));
  const skills = await listSkills(workspace.path, false);
  const commands = await listCommands(workspace.path, "workspace");
  const skillContents = await Promise.all(
    skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      content: await readFile(skill.path, "utf8"),
    })),
  );
  const commandContents = await Promise.all(
    commands.map(async (command) => ({
      name: command.name,
      description: command.description,
      template: command.template,
    })),
  );

  return {
    workspaceId: workspace.id,
    exportedAt: Date.now(),
    opencode,
    veslo,
    skills: skillContents,
    commands: commandContents,
  };
}

export async function importWorkspace(workspace: WorkspaceInfo, payload: Record<string, unknown>): Promise<void> {
  const modes = (payload.mode as Record<string, string> | undefined) ?? {};
  const opencode = payload.opencode as Record<string, unknown> | undefined;
  const veslo = payload.veslo as Record<string, unknown> | undefined;
  const skills = (payload.skills as { name: string; content: string; description?: string }[] | undefined) ?? [];
  const commands = (payload.commands as {
    name: string;
    content?: string;
    description?: string;
    template?: string;
    agent?: string;
    model?: string | null;
    subtask?: boolean;
  }[] | undefined) ?? [];

  if (opencode) {
    if (modes.opencode === "replace") {
      await writeJsoncFile(opencodeConfigPath(workspace.path), opencode);
    } else {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), opencode);
    }
  }

  if (veslo) {
    if (modes.veslo === "replace") {
      await writeVesloConfig(workspace.path, veslo, false);
    } else {
      await writeVesloConfig(workspace.path, veslo, true);
    }
  }

  if (skills.length > 0) {
    if (modes.skills === "replace") {
      await rm(workspaceSkillsRoot(workspace.path), { recursive: true, force: true });
    }
    for (const skill of skills) {
      await upsertSkill(workspace.path, skill);
    }
  }

  if (commands.length > 0) {
    if (modes.commands === "replace") {
      await rm(projectCommandsDir(workspace.path), { recursive: true, force: true });
    }
    for (const command of commands) {
      if (command.content) {
        const parsed = parseFrontmatter(command.content);
        const name = command.name || (typeof parsed.data.name === "string" ? parsed.data.name : "");
        const description = command.description ||
          (typeof parsed.data.description === "string" ? parsed.data.description : undefined);
        if (!name) {
          throw new ApiError(400, "invalid_command", "Command name is required");
        }
        const template = parsed.body.trim();
        await upsertCommand(workspace.path, {
          name,
          description,
          template,
          agent: typeof parsed.data.agent === "string" ? parsed.data.agent : undefined,
          model: typeof parsed.data.model === "string" ? parsed.data.model : undefined,
          subtask: typeof parsed.data.subtask === "boolean" ? parsed.data.subtask : undefined,
        });
      } else {
        const name = command.name ?? "";
        const template = command.template ?? "";
        await upsertCommand(workspace.path, {
          name,
          description: command.description,
          template,
          agent: command.agent,
          model: command.model,
          subtask: command.subtask,
        });
      }
    }
  }
}

export function createWorkspaceConfigOwner(dependencies: WorkspaceConfigOwnerDependencies) {
  return {
    buildOpencodeAuthHeader,
    buildOpencodeReloadUrl,
    exportWorkspace: (workspace: WorkspaceInfo) => exportWorkspace(workspace, dependencies),
    importWorkspace,
    normalizeConversationReadDirectoryRequest,
    parseOpencodeErrorBody,
    readVesloConfig,
    reloadOpencodeEngine,
    resolveConversationReadDirectory,
    resolveOpencodeDirectory,
    writeVesloConfig,
  };
}

export type WorkspaceConfigOwner = ReturnType<typeof createWorkspaceConfigOwner>;
