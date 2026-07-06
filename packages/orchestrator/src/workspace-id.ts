import { createHash } from "node:crypto";
import { resolve, win32 } from "node:path";

export function stripExtendedWindowsPathPrefix(input: string): string {
  if (/^\\\\\?\\UNC\\/i.test(input)) return `\\\\${input.slice("\\\\?\\UNC\\".length)}`;
  if (/^\/\/\?\/UNC\//i.test(input)) return `//${input.slice("//?/UNC/".length)}`;
  if (/^\\\\\?\\/i.test(input)) return input.slice("\\\\?\\".length);
  if (/^\/\/\?\//i.test(input)) return input.slice("//?/".length);
  return input;
}

export function normalizeWorkspacePath(input: string): string {
  const stripped = stripExtendedWindowsPathPrefix(input.trim());
  const resolved =
    process.platform === "win32" || /^[A-Za-z]:[\\/]/.test(stripped)
      ? win32.resolve(stripped)
      : resolve(stripped);
  return resolved.replace(/[\\/]+$/, "");
}

export function workspaceIdForLocal(path: string): string {
  return `ws-${createHash("sha1").update(normalizeWorkspacePath(path)).digest("hex").slice(0, 12)}`;
}

export function workspaceIdForRemote(baseUrl: string, directory?: string | null): string {
  const key = directory ? `${baseUrl}::${directory}` : baseUrl;
  return `ws-${createHash("sha1").update(key).digest("hex").slice(0, 12)}`;
}

export type WorkspaceRuntimeIdentityInput = {
  appWorkspaceId?: string | null;
  serverWorkspaceId?: string | null;
  workdir?: string | null;
};

export type WorkspaceRuntimeIdentity = {
  workspaceId: string;
  serverWorkspaceId: string | null;
  appWorkspaceId: string | null;
  derivedLocalWorkspaceId: string | null;
  legacyWorkspaceIds: string[];
};

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = trimmed(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function resolveWorkspaceRuntimeIdentity(
  input: WorkspaceRuntimeIdentityInput,
): WorkspaceRuntimeIdentity {
  const serverWorkspaceId = trimmed(input.serverWorkspaceId);
  const appWorkspaceId = trimmed(input.appWorkspaceId);
  const workdir = trimmed(input.workdir);
  const derivedLocalWorkspaceId = workdir ? workspaceIdForLocal(workdir) : "";
  const workspaceId = serverWorkspaceId || appWorkspaceId || derivedLocalWorkspaceId;
  const legacyWorkspaceIds = uniqueNonEmpty([appWorkspaceId, derivedLocalWorkspaceId])
    .filter((id) => id !== workspaceId);

  return {
    workspaceId,
    serverWorkspaceId: serverWorkspaceId || null,
    appWorkspaceId: appWorkspaceId || null,
    derivedLocalWorkspaceId: derivedLocalWorkspaceId || null,
    legacyWorkspaceIds,
  };
}
