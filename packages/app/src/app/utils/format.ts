export function safeStringify(value: unknown) {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(
      value,
      (key, val) => {
        if (val && typeof val === "object") {
          if (seen.has(val as object)) {
            return "<circular>";
          }
          seen.add(val as object);
        }

        const lowerKey = key.toLowerCase();
        if (
          lowerKey === "reasoningencryptedcontent" ||
          lowerKey.includes("api_key") ||
          lowerKey.includes("apikey") ||
          lowerKey.includes("access_token") ||
          lowerKey.includes("refresh_token") ||
          lowerKey.includes("token") ||
          lowerKey.includes("authorization") ||
          lowerKey.includes("cookie") ||
          lowerKey.includes("secret")
        ) {
          return "[redacted]";
        }

        return val;
      },
      2,
    );
  } catch {
    return "<unserializable>";
  }
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / Math.pow(1024, idx);
  const rounded = idx === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[idx]}`;
}

export function formatRelativeTime(timestampMs: number) {
  const delta = Date.now() - timestampMs;

  if (delta < 0) {
    return "just now";
  }

  if (delta < 60_000) {
    return `${Math.max(1, Math.round(delta / 1000))}s ago`;
  }

  if (delta < 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / 60_000))}m ago`;
  }

  if (delta < 24 * 60 * 60_000) {
    return `${Math.max(1, Math.round(delta / (60 * 60_000)))}h ago`;
  }

  return new Date(timestampMs).toLocaleDateString();
}

export function safeParseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function parseTemplateFrontmatter(raw: string) {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) return null;
  const header = trimmed.slice(3, endIndex).trim();
  const body = trimmed.slice(endIndex + 4).replace(/^\r?\n/, "");
  const data: Record<string, string> = {};

  const unescapeValue = (value: string) => {
    if (value.startsWith("\"") && value.endsWith("\"")) {
      const inner = value.slice(1, -1);
      return inner.replace(/\\(\\|\"|n|r|t)/g, (_match, code) => {
        switch (code) {
          case "n":
            return "\n";
          case "r":
            return "\r";
          case "t":
            return "\t";
          case "\\":
            return "\\";
          case "\"":
            return "\"";
          default:
            return code;
        }
      });
    }

    if (value.startsWith("'") && value.endsWith("'")) {
      return value.slice(1, -1).replace(/''/g, "'");
    }

    return value;
  };

  for (const line of header.split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry) continue;
    const colonIndex = entry.indexOf(":");
    if (colonIndex === -1) continue;
    const key = entry.slice(0, colonIndex).trim();
    let value = entry.slice(colonIndex + 1).trim();
    if (!key) continue;
    value = unescapeValue(value);
    data[key] = value;
  }

  return { data, body };
}
