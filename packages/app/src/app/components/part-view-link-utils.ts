export type LinkType = "url" | "file";

export type TextSegment =
  | { kind: "text"; value: string }
  | { kind: "link"; value: string; href: string; type: LinkType };

const WEB_LINK_RE = /^(?:https?:\/\/|www\.)/i;
const FILE_URI_RE = /^file:\/\//i;
const URI_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_PATH_RE = /^[A-Za-z]:[\\/][^\s"'`\)\]\}>]+$/;
const POSIX_PATH_RE = /^\/(?!\/)[^\s"'`\)\]\}>][^\s"'`\)\]\}>]*$/;
const TILDE_PATH_RE = /^~\/[^\s"'`\)\]\}>][^\s"'`\)\]\}>]*$/;
const BARE_FILENAME_RE = /^(?!\.)(?!.*\.\.)(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)$/;
const SAFE_PATH_CHAR_RE = /[^\s"'`\)\]\}>]/;
const LEADING_PUNCTUATION_RE = /["'`\(\[\{<]/;
const TRAILING_PUNCTUATION_RE = /["'`\)\]}>.,:;!?]/;
const FILE_LIKE_EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9]{0,9}$/;

const stripFileReferenceSuffix = (value: string) => {
  const withoutQueryOrFragment = value.replace(/[?#].*$/, "").trim();
  if (!withoutQueryOrFragment) return "";
  return withoutQueryOrFragment.replace(/:(\d+)(?::\d+)?$/, "");
};

const hasFileLikeExtension = (value: string) => {
  const stripped = stripFileReferenceSuffix(value).replace(/[\\/]+$/, "");
  if (!stripped) return false;
  const lastSegment = stripped.split(/[\\/]/).pop() ?? "";
  if (!lastSegment) return false;
  return FILE_LIKE_EXTENSION_RE.test(lastSegment);
};

const isWorkspaceRelativeFilePath = (value: string) => {
  const stripped = stripFileReferenceSuffix(value);
  if (!stripped) return false;

  const normalized = stripped.replace(/\\/g, "/");
  if (!normalized.includes("/")) return false;
  if (normalized.startsWith("/") || normalized.startsWith("~/") || normalized.startsWith("//")) {
    return false;
  }
  if (URI_SCHEME_RE.test(normalized)) return false;
  if (/^[A-Za-z]:\//.test(normalized)) return false;

  const segments = normalized.split("/");
  if (!segments.length) return false;
  if (!segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")) return false;

  // Reject purely numeric paths (e.g. "536/38") — they are not file paths
  if (segments.every((segment) => /^\d+$/.test(segment))) return false;

  return true;
};

const isRelativeFilePath = (value: string) => {
  if (value === "." || value === "..") return false;

  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const hasNonTraversalSegment = segments.some((segment) => segment && segment !== "." && segment !== "..");

  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    return hasNonTraversalSegment;
  }

  const [firstSegment, secondSegment] = normalized.split("/");
  if (!secondSegment || firstSegment.length <= 1) return false;
  if (secondSegment === "." || secondSegment === "..") return false;
  return firstSegment.startsWith(".") && SAFE_PATH_CHAR_RE.test(secondSegment);
};

const isBareRelativeFilePath = (value: string) => {
  if (value.includes("/") || value.includes("\\") || value.includes(":")) return false;
  if (!BARE_FILENAME_RE.test(value)) return false;

  const extension = value.split(".").pop() ?? "";
  if (!/[A-Za-z]/.test(extension)) return false;

  const allParts = value.split(".");

  // Reject abbreviations where every segment is 1–2 alphabetic chars (e.g. "s.r.o", "a.s")
  if (allParts.every((part) => /^[A-Za-z]{1,2}$/.test(part))) return false;

  const dotCount = allParts.length - 1;
  if (dotCount === 1 && !value.includes("_") && !value.includes("-")) {
    const [name, tld] = value.split(".");
    if (/^[A-Za-z]{2,24}$/.test(name ?? "") && /^[A-Za-z]{2,10}$/.test(tld ?? "")) {
      return false;
    }
  }

  return true;
};

const isLikelyWebLink = (value: string) => WEB_LINK_RE.test(value);

const isLikelyStandaloneFilePath = (value: string) => {
  const stripped = stripFileReferenceSuffix(value);
  if (!stripped || !hasFileLikeExtension(stripped)) return false;

  if (FILE_URI_RE.test(stripped)) return true;
  if (/^[A-Za-z]:[\\/]/.test(stripped)) return true;
  if (stripped.startsWith("/") && !stripped.startsWith("//")) return true;
  if (stripped.startsWith("~/")) return true;
  if (isRelativeFilePath(stripped)) return true;
  if (isWorkspaceRelativeFilePath(stripped)) return true;

  return false;
};

const isLikelyFilePath = (value: string) => {
  if (FILE_URI_RE.test(value)) return true;
  if (WINDOWS_PATH_RE.test(value)) return true;
  if (POSIX_PATH_RE.test(value)) return true;
  if (TILDE_PATH_RE.test(value)) return true;
  if (isRelativeFilePath(value)) return true;
  if (isBareRelativeFilePath(value)) return true;
  if (isWorkspaceRelativeFilePath(value)) return true;
  if (isLikelyStandaloneFilePath(value)) return true;

  return false;
};

export const parseLinkFromToken = (token: string): { href: string; type: LinkType; value: string } | null => {
  let start = 0;
  let end = token.length;

  while (start < end && LEADING_PUNCTUATION_RE.test(token[start] ?? "")) {
    start += 1;
  }

  while (end > start && TRAILING_PUNCTUATION_RE.test(token[end - 1] ?? "")) {
    end -= 1;
  }

  const value = token.slice(start, end);
  if (!value) return null;

  if (isLikelyWebLink(value)) {
    return {
      value,
      type: "url",
      href: value.toLowerCase().startsWith("www.") ? `https://${value}` : value,
    };
  }

  if (isLikelyFilePath(value)) {
    return {
      value,
      type: "file",
      href: value,
    };
  }

  return null;
};

const splitTextTokens = (text: string): TextSegment[] => {
  const tokens: TextSegment[] = [];
  const matches = text.matchAll(/\S+/g);
  let position = 0;

  for (const match of matches) {
    const token = match[0] ?? "";
    const index = match.index ?? 0;

    if (index > position) {
      tokens.push({ kind: "text", value: text.slice(position, index) });
    }

    const link = parseLinkFromToken(token);
    if (!link) {
      tokens.push({ kind: "text", value: token });
    } else {
      const start = token.indexOf(link.value);
      if (start > 0) {
        tokens.push({ kind: "text", value: token.slice(0, start) });
      }
      tokens.push({ kind: "link", value: link.value, href: link.href, type: link.type });
      const end = start + link.value.length;
      if (end < token.length) {
        tokens.push({ kind: "text", value: token.slice(end) });
      }
    }

    position = index + token.length;
  }

  if (position < text.length) {
    tokens.push({ kind: "text", value: text.slice(position) });
  }

  return tokens;
};

const splitStandalonePathLine = (line: string): TextSegment[] | null => {
  const trimmed = line.trim();
  if (!trimmed || !isLikelyStandaloneFilePath(trimmed)) return null;

  const leadingLength = line.length - line.trimStart().length;
  const trailingLength = line.length - line.trimEnd().length;
  const segments: TextSegment[] = [];

  if (leadingLength > 0) {
    segments.push({ kind: "text", value: line.slice(0, leadingLength) });
  }

  segments.push({ kind: "link", value: trimmed, href: trimmed, type: "file" });

  if (trailingLength > 0) {
    segments.push({ kind: "text", value: line.slice(line.length - trailingLength) });
  }

  return segments;
};

export const splitTextWithStandalonePathLinks = (text: string): TextSegment[] => {
  const parts = text.split(/(\r?\n)/);
  const segments: TextSegment[] = [];

  for (const part of parts) {
    if (!part) continue;
    if (part === "\n" || part === "\r\n") {
      segments.push({ kind: "text", value: part });
      continue;
    }

    const standaloneSegments = splitStandalonePathLine(part);
    if (standaloneSegments) {
      segments.push(...standaloneSegments);
      continue;
    }

    segments.push(...splitTextTokens(part));
  }

  return segments;
};

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const renderInlineTextWithLinks = (text: string) =>
  splitTextWithStandalonePathLinks(text)
    .map((token) => {
      if (token.kind === "text") return escapeHtml(token.value);
      return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]">${escapeHtml(token.value)}</a>`;
    })
    .join("");

export const renderCodeSpanWithLink = (text: string, inlineCodeClass: string) => {
  const link = parseLinkFromToken(text);
  const codeHtml = `<code class="${inlineCodeClass}">${escapeHtml(text)}</code>`;
  if (!link || link.type !== "file" || link.value !== text) {
    return codeHtml;
  }

  return `<a href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer" class="underline underline-offset-2 text-dls-accent hover:text-[var(--dls-accent-hover)]">${codeHtml}</a>`;
};

const normalizeRelativePath = (relativePath: string, workspaceRoot: string) => {
  const root = workspaceRoot.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  if (!root) return null;

  const relative = relativePath.trim().replace(/\\/g, "/");
  if (!relative) return null;

  const isPosixRoot = root.startsWith("/");
  const rootValue = isPosixRoot ? root.slice(1) : root;
  const rootParts = rootValue.split("/").filter((value) => value.length > 0);
  const isWindowsDrive = /^[A-Za-z]:$/.test(rootParts[0] ?? "");
  const resolved: string[] = [...rootParts];
  const segments = relative.split("/");

  for (const segment of segments) {
    if (!segment || segment === ".") continue;

    if (segment === "..") {
      if (!(isWindowsDrive && resolved.length === 1)) {
        resolved.pop();
      }
      continue;
    }

    resolved.push(segment);
  }

  const normalized = resolved.join("/");
  if (isPosixRoot) return `/${normalized || ""}` || "/";
  return normalized;
};

export const normalizeFilePath = (href: string, workspaceRoot: string): string | null => {
  const strippedHref = stripFileReferenceSuffix(href);
  if (!strippedHref) return null;

  if (FILE_URI_RE.test(href)) {
    try {
      const parsed = new URL(href);
      if (parsed.protocol !== "file:") return null;
      const raw = decodeURIComponent(parsed.pathname || "");
      if (!raw) return null;
      if (/^\/[A-Za-z]:\//.test(raw)) {
        return raw.slice(1);
      }
      if (parsed.hostname && !parsed.pathname.startsWith(`/${parsed.hostname}`) && !raw.startsWith("/")) {
        return `/${parsed.hostname}${raw}`;
      }
      return raw;
    } catch {
      const raw = decodeURIComponent(href.replace(/^file:\/\//, ""));
      if (!raw) return null;
      return raw;
    }
  }

  const trimmed = strippedHref.trim();
  if (isRelativeFilePath(trimmed) || isBareRelativeFilePath(trimmed) || isWorkspaceRelativeFilePath(trimmed)) {
    if (!workspaceRoot) return null;
    return normalizeRelativePath(trimmed, workspaceRoot);
  }

  return href;
};
