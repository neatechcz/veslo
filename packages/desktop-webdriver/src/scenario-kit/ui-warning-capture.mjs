const DEFAULT_CAPTURE_KEY = "__vesloWebDriverUiWarningCapture";

export async function beginUiWarningCapture(browser, {
  captureKey = DEFAULT_CAPTURE_KEY,
  pattern = "synchron",
} = {}) {
  await browser.execute((key, patternSource) => {
    const previous = window[key];
    previous?.observer?.disconnect?.();
    const matcher = new RegExp(patternSource, "i");
    const observations = [];
    const scan = () => {
      const candidates = document.querySelectorAll('[role="alert"], [role="status"], [data-testid="session-composer-toast"], [data-testid="session-operational-error"]');
      for (const element of candidates) {
        const text = element.textContent?.trim() ?? "";
        if (!text || !matcher.test(text)) continue;
        const style = window.getComputedStyle(element);
        if (element.getClientRects().length === 0 || style.display === "none" || style.visibility === "hidden") continue;
        if (!observations.includes(text)) observations.push(text.slice(0, 240));
      }
    };
    const observer = new MutationObserver(scan);
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window[key] = { observer, observations, scan };
    scan();
  }, captureKey, pattern);
}

export async function finishUiWarningCapture(browser, {
  captureKey = DEFAULT_CAPTURE_KEY,
  label = "forbidden UI warning",
} = {}) {
  const observations = await browser.execute((key) => {
    const capture = window[key];
    capture?.scan?.();
    capture?.observer?.disconnect?.();
    const result = Array.isArray(capture?.observations) ? [...capture.observations] : [];
    delete window[key];
    return result;
  }, captureKey);
  if (observations.length > 0) {
    throw new Error(`Observed ${label}: ${observations.join(" | ")}`);
  }
  return observations;
}
