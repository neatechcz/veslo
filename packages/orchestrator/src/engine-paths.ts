import { win32 } from "node:path";

import type { WorkerSandbox } from "./sandbox/types.js";

export type EnginePathMapping = {
  backend: WorkerSandbox["name"] | "none";
  hostWorkspacePath: string;
  engineWorkspacePath?: string;
};

export function resolveEnginePathMappingBackend(input: {
  configuredBackend: EnginePathMapping["backend"];
  engineChildKind?: "direct" | "wsl" | null;
  sharedUnsandboxed?: boolean;
}): EnginePathMapping["backend"] {
  if (input.sharedUnsandboxed) return "none";
  if (input.configuredBackend === "windows-wsl2" && input.engineChildKind !== "wsl") return "none";
  return input.configuredBackend;
}

function isWsl2Mapping(mapping: EnginePathMapping): boolean {
  return mapping.backend === "windows-wsl2";
}

function normalizeHostPath(path: string): string {
  let value = path.trim().replace(/\//g, "\\");
  if (value.startsWith("\\\\?\\")) value = value.slice(4);
  return value.replace(/\\+$/, "").toLowerCase();
}

/**
 * OpenCode stores and compares Windows workspace directories as regular drive
 * or UNC paths. Tauri can hand us extended-length paths even when the engine is
 * a normal direct child process, so strip only that transport prefix here. This
 * helper is deliberately platform-independent so CI can cover Windows path
 * inputs from any host OS.
 */
export function canonicalizeDirectOpenCodeDirectory(directory: string | null | undefined): string | null | undefined {
  const value = directory?.trim();
  if (!value) return directory;
  if (/^\\\\\?\\UNC\\/i.test(value)) {
    return `\\\\${value.slice("\\\\?\\UNC\\".length)}`;
  }
  if (/^\/\/\?\/UNC\//i.test(value)) {
    return `//${value.slice("//?/UNC/".length)}`;
  }
  if (value.startsWith("\\\\?\\")) return value.slice(4);
  if (value.startsWith("//?/")) return value.slice(4);
  return directory;
}

function wslMountPathToWindowsPath(path: string): string | null {
  const match = path.trim().replace(/\\/g, "/").match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (!match) return null;
  const drive = match[1]?.toUpperCase();
  if (!drive) return null;
  const rest = (match[2] ?? "").replace(/\//g, "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

function appendEngineRelativePath(base: string, relative: string): string {
  const suffix = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  return suffix ? `${base.replace(/\/+$/, "")}/${suffix}` : base.replace(/\/+$/, "") || "/";
}

function appendHostRelativePath(base: string, relative: string): string {
  const suffix = relative.replace(/\//g, "\\").replace(/^\\+/, "");
  return suffix ? win32.join(base, suffix) : base;
}

export function hostDirectoryToEngineDirectory(
  directory: string | null | undefined,
  mapping: EnginePathMapping,
): string | null | undefined {
  if (!isWsl2Mapping(mapping)) return canonicalizeDirectOpenCodeDirectory(directory);
  const value = directory?.trim();
  if (!value) return directory;

  const engineRoot = mapping.engineWorkspacePath ?? "/workspace";
  const normalizedEngineRoot = engineRoot.replace(/\/+$/, "") || "/";
  const unified = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (unified === normalizedEngineRoot || unified.startsWith(`${normalizedEngineRoot}/`)) {
    return unified || normalizedEngineRoot;
  }

  const hostRoot = normalizeHostPath(mapping.hostWorkspacePath);
  const candidate = normalizeHostPath(wslMountPathToWindowsPath(value) ?? value);
  if (candidate === hostRoot) return normalizedEngineRoot;
  if (candidate.startsWith(`${hostRoot}\\`)) {
    return appendEngineRelativePath(normalizedEngineRoot, candidate.slice(hostRoot.length + 1));
  }

  return directory;
}

export function engineDirectoryToHostDirectory(
  directory: string | null | undefined,
  mapping: EnginePathMapping,
): string | null | undefined {
  if (!isWsl2Mapping(mapping)) return directory;
  const value = directory?.trim();
  if (!value) return directory;

  const engineRoot = (mapping.engineWorkspacePath ?? "/workspace").replace(/\/+$/, "") || "/";
  const unified = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (unified === engineRoot) return mapping.hostWorkspacePath;
  if (unified.startsWith(`${engineRoot}/`)) {
    return appendHostRelativePath(mapping.hostWorkspacePath, unified.slice(engineRoot.length + 1));
  }

  const hostCandidate = wslMountPathToWindowsPath(unified);
  if (hostCandidate) {
    const hostRoot = normalizeHostPath(mapping.hostWorkspacePath);
    const candidate = normalizeHostPath(hostCandidate);
    if (candidate === hostRoot) return mapping.hostWorkspacePath;
    if (candidate.startsWith(`${hostRoot}\\`)) {
      return appendHostRelativePath(mapping.hostWorkspacePath, candidate.slice(hostRoot.length + 1));
    }
  }

  return directory;
}

export function rewriteDirectoryQueryForEngine(
  search: string,
  input: {
    method?: string;
    targetPath: string;
    mapping: EnginePathMapping;
  },
): string {
  if (!search) return search;
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!params.has("directory")) return search;

  if (isWsl2Mapping(input.mapping) && (input.method ?? "GET").toUpperCase() === "GET" && input.targetPath === "/session") {
    params.delete("directory");
  } else {
    const current = params.get("directory");
    const next = hostDirectoryToEngineDirectory(current, input.mapping);
    if (next === current) return search;
    if (typeof next === "string") params.set("directory", next);
  }

  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

function rewriteDirectoryFields(
  value: unknown,
  rewrite: (directory: string | null | undefined) => string | null | undefined,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => rewriteDirectoryFields(item, rewrite));
  }
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "directory" && typeof item === "string") {
      result[key] = rewrite(item);
    } else {
      result[key] = rewriteDirectoryFields(item, rewrite);
    }
  }
  return result;
}

export function rewriteDirectoryFieldsForEngine(value: unknown, mapping: EnginePathMapping): unknown {
  return rewriteDirectoryFields(value, (directory) => hostDirectoryToEngineDirectory(directory, mapping));
}

export function rewriteDirectoryFieldsForHost(value: unknown, mapping: EnginePathMapping): unknown {
  if (!isWsl2Mapping(mapping)) return value;
  return rewriteDirectoryFields(value, (directory) => engineDirectoryToHostDirectory(directory, mapping));
}
