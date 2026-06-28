export type PickerStartPathInput = {
  requestedPath: string;
  existingDirectories: Set<string>;
};

export function choosePickerStartPath(input: PickerStartPathInput): string {
  const requestedPath = normalizePath(input.requestedPath);
  const existingDirectories = new Map(
    Array.from(input.existingDirectories, (directory) => {
      const normalized = normalizePath(directory);
      return [normalized.key, normalized.display] as const;
    }),
  );
  let candidate = requestedPath.key;

  while (candidate) {
    const existingDirectory = existingDirectories.get(candidate);
    if (existingDirectory) return existingDirectory;
    const parent = parentPathKey(candidate, requestedPath.rootKey);
    if (parent === candidate) break;
    candidate = parent;
  }

  return requestedPath.display;
}

export function selectedFolderContainsRequestedPath(
  selectedFolderPath: string,
  requestedPath: string,
): boolean {
  const selected = normalizePath(selectedFolderPath);
  const requested = normalizePath(requestedPath);

  if (!selected.key || !requested.key) return false;
  if (selected.key === requested.key) return true;

  if (selected.key === selected.rootKey && selected.key.endsWith("/")) {
    return requested.key.startsWith(selected.key);
  }

  return requested.key.startsWith(`${selected.key}/`);
}

type NormalizedPath = {
  key: string;
  display: string;
  rootKey: string;
};

type PathRoot = {
  rootDisplay: string;
  rootKey: string;
  rest: string;
  caseInsensitive: boolean;
};

function normalizePath(value: string): NormalizedPath {
  const root = splitRoot(value.trim().replace(/\\/g, "/"));
  const displaySegments: string[] = [];
  const keySegments: string[] = [];

  for (const segment of root.rest.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (displaySegments.length > 0) {
        displaySegments.pop();
        keySegments.pop();
      } else if (!root.rootDisplay) {
        displaySegments.push(segment);
        keySegments.push(segment);
      }
      continue;
    }

    displaySegments.push(segment);
    keySegments.push(root.caseInsensitive ? segment.toLowerCase() : segment);
  }

  return {
    key: joinPath(root.rootKey, keySegments),
    display: joinPath(root.rootDisplay, displaySegments),
    rootKey: root.rootKey,
  };
}

function splitRoot(value: string): PathRoot {
  const driveMatch = /^([A-Za-z]:)(?:\/+)?(.*)$/.exec(value);
  if (driveMatch) {
    const rootDisplay = `${driveMatch[1]}/`;
    return {
      rootDisplay,
      rootKey: rootDisplay.toLowerCase(),
      rest: driveMatch[2] ?? "",
      caseInsensitive: true,
    };
  }

  if (value.startsWith("//")) {
    const parts = value.slice(2).split("/").filter(Boolean);
    if (parts.length >= 2) {
      const rootDisplay = `//${parts[0]}/${parts[1]}`;
      return {
        rootDisplay,
        rootKey: rootDisplay.toLowerCase(),
        rest: parts.slice(2).join("/"),
        caseInsensitive: true,
      };
    }
    return { rootDisplay: "//", rootKey: "//", rest: parts.join("/"), caseInsensitive: true };
  }

  if (value.startsWith("/")) {
    return {
      rootDisplay: "/",
      rootKey: "/",
      rest: value.replace(/^\/+/, ""),
      caseInsensitive: false,
    };
  }

  return { rootDisplay: "", rootKey: "", rest: value, caseInsensitive: false };
}

function joinPath(root: string, segments: string[]): string {
  if (segments.length === 0) return root;
  if (!root) return segments.join("/");
  if (root.endsWith("/")) return `${root}${segments.join("/")}`;
  return `${root}/${segments.join("/")}`;
}

function parentPathKey(value: string, root: string): string {
  if (value === root) return value;

  const index = value.lastIndexOf("/");
  if (index < 0) return root || value;
  if (root && index < root.length) return root;
  if (root && index === root.length - 1) return root;

  return value.slice(0, index) || root || value;
}
