import { win32 } from "node:path";

export function normalizeWindowsPathForWsl(path: string): string {
  const trimmed = path.trim();
  if (/^\\\\\?\\UNC\\/i.test(trimmed)) {
    return `\\\\${trimmed.slice("\\\\?\\UNC\\".length)}`;
  }
  if (/^\/\/\?\/UNC\//i.test(trimmed)) {
    return `//${trimmed.slice("//?/UNC/".length)}`;
  }
  if (/^\\\\\?\\/i.test(trimmed)) {
    return trimmed.slice("\\\\?\\".length);
  }
  if (/^\/\/\?\//i.test(trimmed)) {
    return trimmed.slice("//?/".length);
  }
  return trimmed;
}

export function isUncPath(path: string): boolean {
  return /^\\\\/.test(path) || /^\/\/[^/]/.test(path);
}

export function isDriveLetterPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path);
}

export function isWslMappableWindowsPath(path: string): boolean {
  const normalized = normalizeWindowsPathForWsl(path);
  if (!normalized) return false;
  if (isUncPath(normalized)) return false;
  const resolved = win32.resolve(normalized);
  return isDriveLetterPath(resolved);
}

export function windowsPathToWslPath(path: string): string {
  if (!isWslMappableWindowsPath(path)) {
    throw new Error(`Path cannot be mounted into WSL2: ${path}`);
  }
  const resolved = win32.resolve(normalizeWindowsPathForWsl(path));
  const drive = resolved[0]?.toLowerCase();
  if (!drive || resolved[1] !== ":") {
    throw new Error(`Path is missing a drive letter: ${path}`);
  }
  const rest = resolved.slice(2).replace(/^[\\/]+/, "").replace(/\\/g, "/");
  return rest ? `/mnt/${drive}/${rest}` : `/mnt/${drive}`;
}

export function wslPathToWindowsPath(path: string): string {
  const match = path.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
  if (!match) {
    throw new Error(`WSL path is not under /mnt/<drive>: ${path}`);
  }
  const drive = match[1].toUpperCase();
  const rest = (match[2] ?? "").replace(/\//g, "\\");
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}
