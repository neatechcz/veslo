export const isFileDragTransfer = (
  transfer: Pick<DataTransfer, "types" | "files"> | null | undefined,
): boolean => {
  if (!transfer) return false;

  const files = Array.from((transfer.files ?? []) as ArrayLike<File>).filter(Boolean);
  if (files.length > 0) return true;

  const types = Array.from((transfer.types ?? []) as ArrayLike<string>)
    .map((entry) => entry.toLowerCase())
    .filter(Boolean);
  return types.includes("files");
};

export const extractFilesFromDataTransfer = (transfer: Pick<DataTransfer, "files" | "items"> | null | undefined): File[] => {
  if (!transfer) return [];

  const directFiles = Array.from((transfer.files ?? []) as ArrayLike<File>).filter((file): file is File => Boolean(file));
  if (directFiles.length) return directFiles;

  const itemFiles: File[] = [];
  const items = Array.from((transfer.items ?? []) as ArrayLike<DataTransferItem>);
  for (const item of items) {
    if (!item || item.kind !== "file") continue;
    const file = item.getAsFile?.();
    if (file) itemFiles.push(file);
  }

  return itemFiles;
};

type TransferWithPathData =
  | (Pick<DataTransfer, "getData"> & Partial<Pick<DataTransfer, "types">>)
  | null
  | undefined;

const isAbsoluteReferencePath = (value: string) =>
  value.startsWith("/") || value.startsWith("//") || /^[a-zA-Z]:[\\/]/.test(value);

const basename = (path: string) => {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? normalized;
};

const decodeFileUriPath = (value: string) => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "file:") return "";
    let path = decodeURIComponent(parsed.pathname);
    if (parsed.hostname && parsed.hostname !== "localhost") {
      return `//${parsed.hostname}${path}`;
    }
    if (/^\/[a-zA-Z]:\//.test(path)) {
      path = path.slice(1);
    }
    return path;
  } catch {
    return "";
  }
};

const parseReferencePathsFromText = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => (line.toLowerCase().startsWith("file://") ? decodeFileUriPath(line) : line))
    .filter((line) => line && isAbsoluteReferencePath(line));

const safeGetData = (transfer: TransferWithPathData, type: string) => {
  if (!transfer || typeof transfer.getData !== "function") return "";
  try {
    return transfer.getData(type) ?? "";
  } catch {
    return "";
  }
};

const directFilePath = (file: File) => {
  const record = file as File & {
    path?: string;
    mozFullPath?: string;
    webkitRelativePath?: string;
  };
  return (record.path ?? record.mozFullPath ?? record.webkitRelativePath ?? "").trim();
};

export const extractFileReferencePathsFromDataTransfer = (
  transfer: TransferWithPathData,
  files: File[],
  nativeFilePaths: string[] = [],
): Map<File, string> => {
  const result = new Map<File, string>();
  const candidates = [
    ...parseReferencePathsFromText(safeGetData(transfer, "text/uri-list")),
    ...parseReferencePathsFromText(safeGetData(transfer, "text/plain")),
    ...parseReferencePathsFromText(safeGetData(transfer, "text")),
    ...parseReferencePathsFromText(nativeFilePaths.join("\n")),
  ];

  const seenCandidates = new Set<string>();
  const uniqueCandidates = candidates.filter((candidate) => {
    if (seenCandidates.has(candidate)) return false;
    seenCandidates.add(candidate);
    return true;
  });

  files.forEach((file) => {
    const direct = directFilePath(file);
    if (direct) {
      result.set(file, direct);
    }
  });

  const usedCandidates = new Set<string>();
  files.forEach((file) => {
    if (result.has(file)) return;
    const matchingCandidates = uniqueCandidates.filter((candidate) => basename(candidate) === file.name);
    if (matchingCandidates.length !== 1) return;
    result.set(file, matchingCandidates[0]);
    usedCandidates.add(matchingCandidates[0]);
  });

  const unresolvedFiles = files.filter((file) => !result.has(file));
  const unusedCandidates = uniqueCandidates.filter((candidate) => !usedCandidates.has(candidate));
  unresolvedFiles.forEach((file, index) => {
    if (unusedCandidates.length === unresolvedFiles.length) {
      result.set(file, unusedCandidates[index]);
      return;
    }

    if (unresolvedFiles.length === 1 && unusedCandidates.length === 1) {
      result.set(file, unusedCandidates[0]);
    }
  });

  return result;
};
