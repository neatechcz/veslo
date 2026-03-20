const STARTUP_PREF_KEY = "veslo.startupPref";
const LEGACY_PREF_KEY = "veslo.modePref";
const LEGACY_PREF_KEY_ALT = "veslo_mode_pref";
const OPENWORK_STARTUP_PREF_KEY = "openwork.startupPref";
const OPENWORK_LEGACY_PREF_KEY = "openwork.modePref";
const OPENWORK_LEGACY_PREF_KEY_ALT = "openwork_mode_pref";

export function readStartupPreference(): "local" | "server" | null {
  if (typeof window === "undefined") return null;

  try {
    const pref =
      window.localStorage.getItem(STARTUP_PREF_KEY) ??
      window.localStorage.getItem(LEGACY_PREF_KEY) ??
      window.localStorage.getItem(LEGACY_PREF_KEY_ALT) ??
      window.localStorage.getItem(OPENWORK_STARTUP_PREF_KEY) ??
      window.localStorage.getItem(OPENWORK_LEGACY_PREF_KEY) ??
      window.localStorage.getItem(OPENWORK_LEGACY_PREF_KEY_ALT);

    if (pref === "local" || pref === "server") return pref;
    if (pref === "host") return "local";
    if (pref === "client") return "server";
  } catch {
    // ignore
  }

  return null;
}

export function writeStartupPreference(nextPref: "local" | "server") {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(STARTUP_PREF_KEY, nextPref);
    window.localStorage.removeItem(LEGACY_PREF_KEY);
    window.localStorage.removeItem(LEGACY_PREF_KEY_ALT);
    window.localStorage.removeItem(OPENWORK_STARTUP_PREF_KEY);
    window.localStorage.removeItem(OPENWORK_LEGACY_PREF_KEY);
    window.localStorage.removeItem(OPENWORK_LEGACY_PREF_KEY_ALT);
  } catch {
    // ignore
  }
}

export function clearStartupPreference() {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.removeItem(STARTUP_PREF_KEY);
    window.localStorage.removeItem(LEGACY_PREF_KEY);
    window.localStorage.removeItem(LEGACY_PREF_KEY_ALT);
    window.localStorage.removeItem(OPENWORK_STARTUP_PREF_KEY);
    window.localStorage.removeItem(OPENWORK_LEGACY_PREF_KEY);
    window.localStorage.removeItem(OPENWORK_LEGACY_PREF_KEY_ALT);
  } catch {
    // ignore
  }
}

export function addOpencodeCacheHint(message: string) {
  const lower = message.toLowerCase();
  const cacheSignals = [
    ".cache/opencode",
    "library/caches/opencode",
    "appdata/local/opencode",
    "fetch_jwks.js",
    "opencode cache",
  ];

  if (cacheSignals.some((signal) => lower.includes(signal)) && lower.includes("enoent")) {
    return `${message}\n\nOpenCode cache looks corrupted. Use Repair cache in Settings to rebuild it.`;
  }

  return message;
}
