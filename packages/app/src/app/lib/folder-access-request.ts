export type PickerStartPathInput = {
  requestedPath: string;
  existingDirectories: Set<string>;
};

export function choosePickerStartPath(input: PickerStartPathInput): string {
  const requestedPath = normalizePath(input.requestedPath);
  const existingDirectories = new Set(Array.from(input.existingDirectories, normalizePath));
  let candidate = requestedPath;

  while (candidate) {
    if (existingDirectories.has(candidate)) return candidate;
    const parent = parentPath(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }

  return requestedPath;
}

export function selectedFolderContainsRequestedPath(
  selectedFolderPath: string,
  requestedPath: string,
): boolean {
  const selected = normalizePath(selectedFolderPath);
  const requested = normalizePath(requestedPath);

  if (!selected || !requested) return false;
  if (selected === requested) return true;

  const separator = pathSeparatorFor(selected);
  if (rootLength(selected, separator) === selected.length) return requested.startsWith(selected);
  return requested.startsWith(`${selected}${separator}`);
}

function normalizePath(value: string): string {
  const separator = value.includes("\\") && !value.includes("/") ? "\\" : "/";
  const repeatedSeparators = separator === "\\" ? /\\+/g : /\/+/g;
  let normalized = value.trim().replace(repeatedSeparators, separator);

  while (normalized.length > rootLength(normalized, separator) && normalized.endsWith(separator)) {
    normalized = normalized.slice(0, -1);
  }

  return normalized;
}

function parentPath(value: string): string {
  const separator = pathSeparatorFor(value);
  const root = rootLength(value, separator);
  if (value.length === root) return value;

  const index = value.lastIndexOf(separator);

  if (index < 0) return value;
  if (index < root) return value.slice(0, root);
  if (index === root - 1) return value.slice(0, root);
  return value.slice(0, index);
}

function pathSeparatorFor(value: string): "/" | "\\" {
  return value.includes("\\") && !value.includes("/") ? "\\" : "/";
}

function rootLength(value: string, separator: "/" | "\\"): number {
  if (separator === "\\") {
    if (/^[A-Za-z]:\\/.test(value)) return 3;
    if (/^[A-Za-z]:$/.test(value)) return 2;
    if (value.startsWith("\\\\")) {
      const parts = value.split("\\").filter(Boolean);
      if (parts.length >= 2) return `\\\\${parts[0]}\\${parts[1]}`.length;
    }
    return value.startsWith("\\") ? 1 : 0;
  }

  return value.startsWith("/") ? 1 : 0;
}
