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
