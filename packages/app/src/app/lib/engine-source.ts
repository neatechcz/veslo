export type EngineSourcePreference = "path" | "sidecar" | "custom";

export function parseStoredEngineSourceExplicitPreference(value: string | null | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function resolveStoredEngineSourcePreference(options: {
  isTauriRuntime: boolean;
  storedSource: string | null | undefined;
  storedCustomBinPath: string | null | undefined;
  storedSourceExplicit: boolean;
}): {
  source: EngineSourcePreference;
  explicit: boolean;
} {
  const fallbackSource: EngineSourcePreference = options.isTauriRuntime ? "sidecar" : "path";
  const source = options.storedSource;
  const hasCustomBinPath = typeof options.storedCustomBinPath === "string" && options.storedCustomBinPath.trim().length > 0;

  if (source !== "path" && source !== "sidecar" && source !== "custom") {
    return {
      source: fallbackSource,
      explicit: false,
    };
  }

  if (source === "custom") {
    if (!hasCustomBinPath) {
      return {
        source: fallbackSource,
        explicit: false,
      };
    }

    return {
      source,
      explicit: true,
    };
  }

  // In the Tauri desktop runtime, "path" (= /opt/homebrew/bin/opencode, /usr/local/bin/opencode, etc.)
  // is no longer supported. Homebrew currently ships opencode 1.3.2 but the bundled orchestrator
  // requires 1.16.2; spawning against the system binary silently times out. Always migrate to the
  // bundled sidecar regardless of whether the user explicitly chose "path" in the past — they can
  // still pick a specific binary via "Custom binary path" in Settings → Advanced.
  if (options.isTauriRuntime && source === "path") {
    return {
      source: "sidecar",
      explicit: false,
    };
  }

  return {
    source,
    explicit: options.storedSourceExplicit,
  };
}
