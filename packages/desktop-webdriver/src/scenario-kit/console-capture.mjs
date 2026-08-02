import { sanitizeScenarioArtifactValue } from "./redaction.mjs";

export async function beginConsoleCapture(browser) {
  await browser.execute(() => {
    const key = "__vesloWebDriverConsoleCapture";
    if (window[key]?.active) {
      window[key].entries.length = 0;
      return;
    }
    const entries = [];
    const serialize = (value, depth = 0) => {
      if (depth > 3) return "[truncated-depth]";
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value == null) return value;
      if (Array.isArray(value)) return value.slice(0, 50).map((item) => serialize(item, depth + 1));
      if (typeof value === "object") {
        try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
      }
      return String(value);
    };
    const original = {};
    for (const level of ["debug", "info", "log", "warn", "error"]) {
      original[level] = console[level].bind(console);
      console[level] = (...args) => {
        entries.push({ at: new Date().toISOString(), level, args: args.map((arg) => serialize(arg)) });
        original[level](...args);
      };
    }
    window[key] = { active: true, entries };
  });
}

export async function collectDevConsoleLogs(browser) {
  const captured = await browser.execute(() => window.__vesloWebDriverConsoleCapture?.entries ?? []);
  // Veslo's loopback WebDriver endpoint does not implement the optional W3C
  // browser-log command reliably. Calling it in teardown can leave a completed
  // scenario waiting forever and prevent its diagnostic artifact from being
  // written. The injected capture above is owned by this runner and the
  // runtime NDJSON trace remains the canonical diagnostic record.
  return sanitizeScenarioArtifactValue({
    captured,
    protocol: [],
    protocolUnavailable: "loopback-webdriver-browser-logs-unsupported",
  });
}
