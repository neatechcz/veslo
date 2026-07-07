const LEGACY_SCHEDULER_PLUGIN = "opencode-scheduler";

type SanitizeResult = {
  text: string;
  changed: boolean;
};

function removeLegacySchedulerPlugin(config: unknown): boolean {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return false;
  }

  const obj = config as Record<string, unknown>;
  const plugin = obj.plugin;
  if (plugin === LEGACY_SCHEDULER_PLUGIN) {
    delete obj.plugin;
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
    obj.plugin = filtered;
  } else {
    delete obj.plugin;
  }
  return true;
}

export function sanitizeOpencodeRuntimeConfigText(raw: string): SanitizeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, changed: false };
  }

  if (!removeLegacySchedulerPlugin(parsed)) {
    return { text: raw, changed: false };
  }

  return {
    text: `${JSON.stringify(parsed, null, 2)}\n`,
    changed: true,
  };
}
