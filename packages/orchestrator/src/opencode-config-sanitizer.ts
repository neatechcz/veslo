const LEGACY_SCHEDULER_PLUGIN = "opencode-scheduler";
const CHROME_MCP_ALIASES = ["chrome-devtools", "control-chrome"] as const;
const CHROME_MCP_COMMAND = ["chrome-devtools-mcp", "--isolated"] as const;

type SanitizeResult = {
  text: string;
  changed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function removeLegacySchedulerPlugin(config: unknown): boolean {
  if (!isRecord(config)) {
    return false;
  }

  const plugin = config.plugin;
  if (plugin === LEGACY_SCHEDULER_PLUGIN) {
    delete config.plugin;
    return true;
  }

  if (!Array.isArray(plugin)) {
    return false;
  }

  const filtered = plugin.filter((entry) => entry !== LEGACY_SCHEDULER_PLUGIN);
  if (filtered.length === plugin.length) {
    return false;
  }

  if (filtered.length) {
    config.plugin = filtered;
  } else {
    delete config.plugin;
  }
  return true;
}

function isChromeMcpPackage(value: string): boolean {
  return value === "chrome-devtools-mcp" || value.startsWith("chrome-devtools-mcp@");
}

function isLegacyChromeMcpCommandParts(parts: string[]): boolean {
  if (parts[0] === "npx") {
    const normalized = parts.slice(1).filter((part) => part !== "-y" && part !== "--yes");
    return normalized.length === 2 && isChromeMcpPackage(normalized[0] ?? "") && normalized[1] === "--isolated";
  }

  if (parts[0] === "npm" && parts[1] === "exec") {
    const normalized = parts.slice(2).filter((part) => part !== "-y" && part !== "--yes" && part !== "--");
    return normalized.length === 2 && isChromeMcpPackage(normalized[0] ?? "") && normalized[1] === "--isolated";
  }

  return false;
}

function isLegacyChromeMcpCommand(config: unknown): boolean {
  if (!isRecord(config) || config.type !== "local" || !Array.isArray(config.command)) {
    return false;
  }
  const parts = config.command.filter((part): part is string => typeof part === "string");
  return parts.length === config.command.length && isLegacyChromeMcpCommandParts(parts);
}

function migrateLegacyChromeMcpCommands(config: unknown): boolean {
  if (!isRecord(config) || !isRecord(config.mcp)) {
    return false;
  }

  let changed = false;
  for (const key of CHROME_MCP_ALIASES) {
    if (!isLegacyChromeMcpCommand(config.mcp[key])) {
      continue;
    }
    config.mcp[key] = {
      type: "local",
      command: [...CHROME_MCP_COMMAND],
    };
    changed = true;
  }
  return changed;
}

export function sanitizeOpencodeRuntimeConfigText(raw: string): SanitizeResult {
  const hasBom = raw.charCodeAt(0) === 0xfeff;
  const parseInput = hasBom ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(parseInput);
  } catch {
    return { text: raw, changed: false };
  }

  let changed = false;
  changed = removeLegacySchedulerPlugin(parsed) || changed;
  changed = migrateLegacyChromeMcpCommands(parsed) || changed;

  if (!changed) {
    return { text: raw, changed: false };
  }

  return {
    text: `${hasBom ? "\ufeff" : ""}${JSON.stringify(parsed, null, 2)}\n`,
    changed: true,
  };
}
