import type {
  SessionArtifactFamily,
  SessionArtifactItem,
  SessionArtifactKind,
  SessionArtifactStatus,
  SessionLatestRunArtifactsResponse,
} from "./types.js";

type RecordLike = Record<string, unknown>;

type SessionArtifactSource = {
  sessionId?: string;
  workspaceId?: string;
  messages?: SessionArtifactMessage[];
};

export type SessionArtifactMessage = {
  id?: string;
  role?: string;
  info?: {
    id?: string;
    role?: string;
    sessionID?: string;
    time?: {
      created?: number;
    };
  };
  time?: {
    created?: number;
  };
  parts?: SessionArtifactPart[];
};

export type SessionArtifactPart = {
  id?: string;
  type?: string;
  tool?: string;
  path?: string;
  file?: string;
  filePath?: string;
  target?: string;
  files?: string[];
  sourceName?: string;
  server?: string;
  title?: string;
  metadata?: RecordLike;
  state?: ToolStateLike;
};

type ToolStateLike = {
  status?: string;
  input?: RecordLike;
  output?: string;
  title?: string;
  metadata?: RecordLike;
  time?: {
    start?: number;
    end?: number;
  };
  attachments?: Array<{
    filename?: string;
    source?: {
      path?: string;
    };
  }>;
};

type LatestRunSlice = {
  runId: string | null;
  messages: SessionArtifactMessage[];
};

type DeriveArtifactsOptions = {
  workspaceId?: string;
  workspaceRoot?: string;
  mcpServerNames?: string[];
};

const FILE_OUTPUT_TOOLS = new Set(["write", "edit", "apply_patch"]);
const FILE_OPEN_TOOLS = new Set(["read"]);
const FILE_ARTIFACT_RANK: Record<SessionArtifactKind, number> = {
  file_discovered: 1,
  file_output: 2,
  skill_used: 1,
  mcp_used: 1,
  soul_memory_used: 1,
  heartbeat_used: 1,
};
const MCP_SERVER_LABELS: Record<string, string> = {
  "chrome-devtools": "Chrome DevTools",
};

export function deriveLatestRunArtifacts(source: SessionArtifactSource, options: DeriveArtifactsOptions = {}): SessionArtifactItem[] {
  const sessionId = normalizeIdentifier(source.sessionId);
  const workspaceId = normalizeIdentifier(source.workspaceId) || normalizeIdentifier(options.workspaceId);
  const latestRun = sliceLatestRun(source.messages ?? []);
  const items = deriveArtifactsForRun({
    sessionId,
    workspaceId,
    runId: latestRun.runId ?? "latest-run",
    messages: latestRun.messages,
    workspaceRoot: options.workspaceRoot,
    mcpServerNames: new Set((options.mcpServerNames ?? []).map((name) => name.trim().toLowerCase()).filter(Boolean)),
  });

  return items;
}

export function deriveLatestRunArtifactsFromMessages(
  messages: SessionArtifactMessage[],
  options: DeriveArtifactsOptions = {},
): SessionLatestRunArtifactsResponse {
  const sessionId = resolveSessionId(messages);
  const source: SessionArtifactSource = {
    sessionId,
    workspaceId: normalizeIdentifier(options.workspaceId),
    messages,
  };
  return deriveLatestRunArtifactsResponse(source, options);
}

export function deriveLatestRunArtifactsResponse(
  source: SessionArtifactSource,
  options: DeriveArtifactsOptions = {},
): SessionLatestRunArtifactsResponse {
  const latestRun = sliceLatestRun(source.messages ?? []);
  return {
    sessionId: normalizeIdentifier(source.sessionId) || resolveSessionId(source.messages ?? []),
    workspaceId: normalizeIdentifier(source.workspaceId) || normalizeIdentifier(options.workspaceId),
    runId: latestRun.runId,
    items: deriveLatestRunArtifacts(source, options),
  };
}

export function hasSoulArtifacts(items: SessionArtifactItem[]): boolean {
  return items.some((item) => item.family === "soul");
}

function deriveArtifactsForRun(input: {
  sessionId: string;
  workspaceId: string;
  runId: string;
  messages: SessionArtifactMessage[];
  workspaceRoot?: string;
  mcpServerNames: Set<string>;
}): SessionArtifactItem[] {
  const byKey = new Map<string, SessionArtifactItem>();
  let order = 0;

  for (const message of input.messages) {
    for (const part of message.parts ?? []) {
      if (part.type !== "tool") continue;
      const toolName = normalizeToolName(part.tool);
      if (!toolName) continue;

      const timestamp = resolveTimestamp(message, part, order);
      order += 1;
      const nextItems = classifyToolPart({
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        runId: input.runId,
        messageId: resolveMessageId(message),
        partId: normalizeIdentifier(part.id),
        part,
        toolName,
        timestamp,
        workspaceRoot: input.workspaceRoot,
        mcpServerNames: input.mcpServerNames,
      });

      for (const item of nextItems) {
        const key = artifactKey(item);
        const existing = byKey.get(key);
        if (!existing || shouldReplaceArtifact(existing, item)) {
          byKey.set(key, item);
        }
      }
    }
  }

  return Array.from(byKey.values()).sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    return left.id.localeCompare(right.id);
  });
}

function classifyToolPart(input: {
  sessionId: string;
  workspaceId: string;
  runId: string;
  messageId: string;
  partId: string;
  part: SessionArtifactPart;
  toolName: string;
  timestamp: number;
  workspaceRoot?: string;
  mcpServerNames: Set<string>;
}): SessionArtifactItem[] {
  const items: SessionArtifactItem[] = [];
  const state = input.part.state ?? {};

  const skillName = resolveSkillName(input.part, state, input.toolName);
  if (skillName) {
    items.push(
      createArtifact({
        ...input,
        family: "skills",
        kind: "skill_used",
        status: "used",
        title: skillName,
        sourceName: skillName,
      }),
    );
  }

  const mcpServer = resolveMcpServer(input.part, state, input.toolName, input.mcpServerNames);
  if (mcpServer) {
    items.push(
      createArtifact({
        ...input,
        family: "mcp",
        kind: "mcp_used",
        status: "used",
        title: resolveMcpTitle(input.part, state, mcpServer),
        sourceName: mcpServer,
      }),
    );
  }

  const soulKinds = resolveSoulKinds(input.part, state, input.toolName, input.workspaceRoot);
  if (soulKinds.has("soul_memory_used")) {
    items.push(
        createArtifact({
          ...input,
          family: "soul",
          kind: "soul_memory_used",
          status: "used",
          title: "Soul memory",
          sourceName: "soul",
        }),
    );
  }
  if (soulKinds.has("heartbeat_used")) {
    items.push(
        createArtifact({
          ...input,
          family: "soul",
          kind: "heartbeat_used",
          status: "used",
          title: "Heartbeat",
          sourceName: "soul",
        }),
    );
  }

  if (FILE_OUTPUT_TOOLS.has(input.toolName)) {
    for (const path of resolveFileOutputPaths(input.part, state, input.toolName)) {
      const normalizedPath = normalizeArtifactPath(path, { workspaceRoot: input.workspaceRoot });
      if (!normalizedPath || shouldDropGenericFileArtifact(normalizedPath) || isSemanticSoulPath(normalizedPath)) continue;
      items.push(
        createArtifact({
          ...input,
          family: "files",
          kind: "file_output",
          status: "updated",
          title: basename(normalizedPath),
          subtitle: normalizedPath,
          path: normalizedPath,
        }),
      );
    }
  }

  if (FILE_OPEN_TOOLS.has(input.toolName)) {
    for (const path of resolveFileOpenedPaths(input.part, state)) {
      const normalizedPath = normalizeArtifactPath(path, { workspaceRoot: input.workspaceRoot });
      if (!normalizedPath || shouldDropGenericFileArtifact(normalizedPath) || isSemanticSoulPath(normalizedPath)) continue;
      items.push(
        createArtifact({
          ...input,
          family: "files",
          kind: "file_discovered",
          status: "scanned",
          title: basename(normalizedPath),
          subtitle: normalizedPath,
          path: normalizedPath,
        }),
      );
    }
  }

  return items;
}

function resolveSkillName(part: SessionArtifactPart, state: ToolStateLike, toolName: string): string | null {
  if (toolName !== "skill") return null;
  const input = state.input ?? {};
  const raw = firstNonEmptyString([
    part.sourceName,
    part.title,
    readString(state.metadata, "name"),
    readString(input, "name"),
    readString(input, "skill"),
  ]);
  if (!raw) return "Skill";
  return raw.replace(/^load skill\s+/i, "").trim() || "Skill";
}

function resolveMcpServer(
  part: SessionArtifactPart,
  state: ToolStateLike,
  toolName: string,
  knownServerNames: Set<string>,
): string | null {
  const input = state.input ?? {};
  const explicit = firstNonEmptyString([
    part.server,
    readString(part.metadata, "server"),
    readString(state.metadata, "server"),
    readString(input, "server"),
  ]);

  if (explicit) {
    const normalizedExplicit = explicit.toLowerCase();
    if (knownServerNames.size === 0 || knownServerNames.has(normalizedExplicit)) {
      return explicit;
    }
  }

  if (toolName.startsWith("chrome-devtools.")) {
    if (knownServerNames.size > 0 && !knownServerNames.has("chrome-devtools")) return null;
    return "chrome-devtools";
  }

  return null;
}

function resolveMcpTitle(part: SessionArtifactPart, state: ToolStateLike, serverName: string): string {
  return firstNonEmptyString([part.title, state.title]) ?? MCP_SERVER_LABELS[serverName] ?? humanizeIdentifier(serverName);
}

function resolveSoulKinds(
  part: SessionArtifactPart,
  state: ToolStateLike,
  toolName: string,
  workspaceRoot?: string,
): Set<SessionArtifactKind> {
  const kinds = new Set<SessionArtifactKind>();
  if (toolName === "soul.memory") kinds.add("soul_memory_used");
  if (toolName === "soul.heartbeat") kinds.add("heartbeat_used");

  for (const rawPath of collectPathCandidates(part, state)) {
    const path = normalizeArtifactPath(rawPath, { workspaceRoot });
    if (!path) continue;
    if (isSemanticSoulPath(path)) kinds.add("soul_memory_used");
  }

  return kinds;
}

function resolveFileOutputPaths(part: SessionArtifactPart, state: ToolStateLike, toolName: string): string[] {
  const direct = collectPathCandidates(part, state);
  if (toolName !== "apply_patch") return direct;
  return uniqueStrings([
    ...direct,
    ...extractApplyPatchHeaderPaths(readUnknown(state.input, "patch")),
    ...extractApplyPatchSummaryPaths(state.output),
  ]);
}

function resolveFileOpenedPaths(part: SessionArtifactPart, state: ToolStateLike): string[] {
  return uniqueStrings([
    ...collectDirectPaths(part, state),
    ...collectAttachmentPaths(state),
  ]);
}

function collectPathCandidates(part: SessionArtifactPart, state: ToolStateLike): string[] {
  return uniqueStrings([
    ...collectDirectPaths(part, state),
    ...collectStringArray(part.files),
    ...collectStringArray(readUnknown(part.metadata, "files")),
    ...collectStringArray(readUnknown(state.input, "files")),
    ...collectStringArray(readUnknown(state.input, "paths")),
    ...collectAttachmentPaths(state),
  ]);
}

function collectDirectPaths(part: SessionArtifactPart, state: ToolStateLike): string[] {
  return uniqueStrings([
    part.path,
    part.file,
    part.filePath,
    part.target,
    readString(part.metadata, "path"),
    readString(part.metadata, "file"),
    readString(part.metadata, "filePath"),
    readString(part.metadata, "target"),
    readString(state.input, "path"),
    readString(state.input, "file"),
    readString(state.input, "filePath"),
    readString(state.input, "target"),
  ]);
}

function collectAttachmentPaths(state: ToolStateLike): string[] {
  const attachments = Array.isArray(state.attachments) ? state.attachments : [];
  return uniqueStrings(
    attachments.map((attachment) => {
      const source = attachment?.source;
      return typeof source?.path === "string" ? source.path : "";
    }),
  );
}

function extractApplyPatchHeaderPaths(patch: unknown): string[] {
  if (typeof patch !== "string" || !patch.trim()) return [];
  const paths = new Set<string>();
  let pendingMoveSource: string | null = null;

  for (const line of patch.split(/\r?\n/)) {
    const headerMatch = line.match(/^\*\*\* (Add|Update|Delete) File:\s+(.+)$/);
    if (headerMatch) {
      const action = headerMatch[1];
      const path = headerMatch[2]?.trim();
      if (path) {
        paths.add(path);
        pendingMoveSource = action === "Update" ? path : null;
      }
      continue;
    }

    const moveMatch = line.match(/^\*\*\* Move to:\s+(.+)$/);
    if (moveMatch) {
      const path = moveMatch[1]?.trim();
      if (path) {
        if (pendingMoveSource) paths.delete(pendingMoveSource);
        paths.add(path);
      }
      pendingMoveSource = null;
      continue;
    }

    if (/^\*\*\* /.test(line)) pendingMoveSource = null;
  }

  return Array.from(paths);
}

function extractApplyPatchSummaryPaths(output: unknown): string[] {
  if (typeof output !== "string" || !output.trim()) return [];
  const matches = output.matchAll(/(?:^|\n)\s*[MADR]\s+([^\n]+)/g);
  const paths: string[] = [];
  for (const match of matches) {
    const candidate = match[1]?.trim();
    if (candidate) paths.push(candidate);
  }
  return uniqueStrings(paths);
}

function sliceLatestRun(messages: SessionArtifactMessage[]): LatestRunSlice {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (resolveMessageRole(message) !== "user") continue;
    return {
      runId: resolveMessageId(message) || null,
      messages: messages.slice(index + 1),
    };
  }

  return {
    runId: resolveMessageId(messages[0]) || null,
    messages: messages.slice(),
  };
}

function createArtifact(input: {
  sessionId: string;
  workspaceId: string;
  runId: string;
  messageId: string;
  partId: string;
  toolName: string;
  timestamp: number;
  family: SessionArtifactFamily;
  kind: SessionArtifactKind;
  status: SessionArtifactStatus;
  title: string;
  subtitle?: string;
  path?: string;
  sourceName?: string;
}): SessionArtifactItem {
  const identity = input.path ?? input.sourceName ?? input.title;
  return {
    id: `${input.runId}:${input.family}:${input.kind}:${identity.toLowerCase()}`,
    sessionId: input.sessionId,
    workspaceId: input.workspaceId,
    runId: input.runId,
    family: input.family,
    kind: input.kind,
    status: input.status,
    title: input.title,
    subtitle: input.subtitle,
    path: input.path,
    sourceName: input.sourceName,
    messageId: input.messageId || undefined,
    partId: input.partId || undefined,
    timestamp: input.timestamp,
    metadata: { tool: input.toolName },
  };
}

function artifactKey(item: SessionArtifactItem): string {
  switch (item.family) {
    case "files":
      return `files:${(item.path ?? item.title).toLowerCase()}`;
    case "skills":
      return `skills:${(item.sourceName ?? item.title).toLowerCase()}`;
    case "mcp":
      return `mcp:${(item.sourceName ?? item.title).toLowerCase()}`;
    case "soul":
      return `soul:${item.kind}`;
  }
}

function shouldReplaceArtifact(current: SessionArtifactItem, next: SessionArtifactItem): boolean {
  if (current.family === "files" && next.family === "files" && current.path && next.path && current.path === next.path) {
    const currentRank = FILE_ARTIFACT_RANK[current.kind];
    const nextRank = FILE_ARTIFACT_RANK[next.kind];
    if (nextRank !== currentRank) return nextRank > currentRank;
  }
  return next.timestamp >= current.timestamp;
}

function shouldDropGenericFileArtifact(path: string): boolean {
  if (path === ".opencode") return true;
  if (basename(path).toLowerCase() === "agents.md") return true;
  if (/^\.opencode\/agents\/.+\.md$/i.test(path)) return true;
  if (/^\.opencode\/skills\/.+\/skill\.md$/i.test(path)) return true;
  if (/^\.opencode\/veslo\/internal\//i.test(path)) return true;
  return false;
}

function isSemanticSoulPath(path: string): boolean {
  return path === ".opencode/soul-company.md" ||
    path === ".opencode/soul-user.md" ||
    path === ".opencode/soul-workspace.md";
}

function sanitizeRelativeArtifactPath(value: string): string | null {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  return parts.join("/");
}

function normalizeWindowsExtendedPrefix(value: string): string {
  if (/^\/\/\?\/UNC\//i.test(value)) return `//${value.slice("//?/UNC/".length)}`;
  if (/^\/\/\?\//i.test(value)) return value.slice("//?/".length);
  return value;
}

function normalizeComparablePath(value: string): string {
  return normalizeWindowsExtendedPrefix(value.trim().replace(/\\/g, "/")).replace(/\/+$/, "");
}

function isWindowsLikePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value) || value.startsWith("//");
}

function relativeFromRoot(value: string, root: string): string | null {
  const candidate = normalizeComparablePath(value);
  const workspaceRoot = normalizeComparablePath(root);
  if (!candidate || !workspaceRoot) return null;

  const caseInsensitive = isWindowsLikePath(candidate) || isWindowsLikePath(workspaceRoot);
  const candidateKey = caseInsensitive ? candidate.toLowerCase() : candidate;
  const rootKey = caseInsensitive ? workspaceRoot.toLowerCase() : workspaceRoot;
  if (candidateKey === rootKey) return null;
  if (rootKey === "/" && candidate.startsWith("/")) {
    return sanitizeRelativeArtifactPath(candidate.slice(1));
  }
  if (!candidateKey.startsWith(`${rootKey}/`)) return null;
  return sanitizeRelativeArtifactPath(candidate.slice(workspaceRoot.length + 1));
}

function wslMountPathToWindowsPath(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/");
  const match = normalized.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (!match) return null;
  const drive = match[1]?.toUpperCase();
  if (!drive) return null;
  const rest = match[2]?.trim() ?? "";
  return rest ? `${drive}:/${rest}` : `${drive}:/`;
}

function relativeFromWorkspaceAlias(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, "/");
  if (normalized === "/workspace" || normalized === "workspace") return null;
  if (normalized.startsWith("/workspace/")) {
    return sanitizeRelativeArtifactPath(normalized.slice("/workspace/".length));
  }
  if (normalized.startsWith("workspace/")) {
    return sanitizeRelativeArtifactPath(normalized.slice("workspace/".length));
  }
  return null;
}

function workspaceRelativeArtifactPath(input: string, workspaceRoot?: string): string | null {
  const raw = input.trim().replace(/\\/g, "/");
  if (!raw) return null;

  const aliasRelative = relativeFromWorkspaceAlias(raw);
  if (aliasRelative) return aliasRelative;

  const root = workspaceRoot?.trim() ?? "";
  if (!root) return null;

  const hostRelative = relativeFromRoot(raw, root);
  if (hostRelative) return hostRelative;

  const windowsPath = wslMountPathToWindowsPath(raw);
  if (windowsPath) {
    return relativeFromRoot(windowsPath, root);
  }

  return null;
}

function normalizeArtifactPath(input: string, options: { workspaceRoot?: string } = {}): string | null {
  const relative = workspaceRelativeArtifactPath(input, options.workspaceRoot);
  if (relative) return relative;

  const raw = input.trim().replace(/\\/g, "/");
  if (!raw) return null;

  const isWindowsDriveAbsolute = /^[A-Za-z]:\//.test(raw);
  const isUncAbsolute = raw.startsWith("//");
  const isUnixAbsolute = raw.startsWith("/") && !isUncAbsolute;
  const hasWorkspaceRoot = Boolean(options.workspaceRoot?.trim());
  if (hasWorkspaceRoot && (isWindowsDriveAbsolute || isUncAbsolute || isUnixAbsolute)) {
    return null;
  }

  let normalized = raw;
  if (isUnixAbsolute) {
    normalized = `/${raw.replace(/^\/+/, "")}`;
  } else if (!isWindowsDriveAbsolute && !isUncAbsolute) {
    normalized = raw.replace(/^\.\//, "").replace(/^workspace\//, "");
  }

  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((part) => part === "." || part === "..")) return null;
  if (isUnixAbsolute) return `/${parts.join("/")}`;
  if (isUncAbsolute) return `//${parts.join("/")}`;
  return parts.join("/");
}

function resolveTimestamp(message: SessionArtifactMessage, part: SessionArtifactPart, fallback: number): number {
  const state = part.state;
  const fromState = state?.time?.end ?? state?.time?.start;
  if (typeof fromState === "number" && Number.isFinite(fromState)) return fromState;
  const fromMessage = message.time?.created ?? message.info?.time?.created;
  if (typeof fromMessage === "number" && Number.isFinite(fromMessage)) return fromMessage;
  return fallback;
}

function normalizeToolName(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeIdentifier(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function resolveSessionId(messages: SessionArtifactMessage[]): string {
  for (const message of messages) {
    const fromMessage = readString(message as unknown as RecordLike, "sessionID") ?? readString(message.info, "sessionID");
    if (fromMessage) return fromMessage;
    for (const part of message.parts ?? []) {
      const fromPart = readString(part as unknown as RecordLike, "sessionID");
      if (fromPart) return fromPart;
    }
  }
  return "";
}

function resolveMessageId(message: SessionArtifactMessage | undefined): string {
  if (!message) return "";
  return normalizeIdentifier(message.id) || normalizeIdentifier(message.info?.id);
}

function resolveMessageRole(message: SessionArtifactMessage): string {
  return normalizeIdentifier(message.role) || normalizeIdentifier(message.info?.role);
}

function readUnknown(record: RecordLike | undefined, key: string): unknown {
  return record && key in record ? record[key] : undefined;
}

function readString(record: RecordLike | undefined, key: string): string | undefined {
  const value = readUnknown(record, key);
  return typeof value === "string" ? value.trim() : undefined;
}

function collectStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value.map((entry) => (typeof entry === "string" ? entry : "")).filter(Boolean),
  );
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  const next = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    next.add(trimmed);
  }
  return Array.from(next);
}

function firstNonEmptyString(values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
