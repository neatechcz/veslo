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

  // Older desktop installs persisted "path" before Veslo bundled a compatible engine.
  // If there is no explicit opt-in, migrate packaged desktop apps back to the sidecar.
  if (options.isTauriRuntime && source === "path" && !options.storedSourceExplicit) {
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
