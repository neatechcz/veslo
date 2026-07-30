import { selectors } from "./selectors.mjs";

const probeKey = "__vesloWebDriverUiStabilityProbe";

export function summarizeUiStabilitySamples(samples, mutationCount, { longFrameMs = 50, layoutShiftPx = 2 } = {}) {
  const longFrames = [];
  const visibilityFlaps = [];
  const layoutShifts = [];
  let maxFrameGapMs = 0;
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    const frameGapMs = Math.max(0, current.timestampMs - previous.timestampMs);
    maxFrameGapMs = Math.max(maxFrameGapMs, frameGapMs);
    if (frameGapMs >= longFrameMs) longFrames.push({ index, frameGapMs });
    for (const [name, currentTarget] of Object.entries(current.targets)) {
      const previousTarget = previous.targets[name];
      if (!previousTarget) continue;
      if (previousTarget.visible !== currentTarget.visible) {
        visibilityFlaps.push({ index, target: name, from: previousTarget.visible, to: currentTarget.visible });
        continue;
      }
      if (!currentTarget.visible || !previousTarget.visible) continue;
      const maxDelta = Math.max(
        Math.abs(currentTarget.x - previousTarget.x),
        Math.abs(currentTarget.y - previousTarget.y),
        Math.abs(currentTarget.width - previousTarget.width),
        Math.abs(currentTarget.height - previousTarget.height),
      );
      if (maxDelta >= layoutShiftPx) layoutShifts.push({ index, target: name, maxDeltaPx: maxDelta });
    }
  }
  return {
    sampleCount: samples.length,
    observedDurationMs: samples.length > 1 ? samples.at(-1).timestampMs - samples[0].timestampMs : 0,
    maxFrameGapMs,
    longFrames,
    visibilityFlaps,
    layoutShifts,
    mutationCount,
    possibleFlicker: visibilityFlaps.length > 0 || layoutShifts.length > 0,
  };
}

export async function startUiStabilityProbe(browser) {
  await browser.execute((key, testIds) => {
    window[key]?.stop?.();
    const samples = [];
    let mutationCount = 0;
    const targetSelectors = {
      appRoot: testIds.appRoot,
      leftSidebar: testIds.leftSidebar,
      sessionCenterPane: testIds.sessionCenterPane,
      composer: testIds.composerInput,
    };
    const targetState = (selector) => {
      const element = document.querySelector(selector);
      if (!element) return { visible: false, x: 0, y: 0, width: 0, height: 0 };
      const rect = element.getBoundingClientRect();
      return {
        visible: rect.width > 0 && rect.height > 0,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    };
    let frameHandle = 0;
    const record = (timestampMs) => {
      samples.push({
        timestampMs: Math.round(timestampMs),
        targets: Object.fromEntries(Object.entries(targetSelectors).map(([name, selector]) => [name, targetState(selector)])),
      });
      frameHandle = requestAnimationFrame(record);
    };
    const observer = new MutationObserver((records) => { mutationCount += records.length; });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    frameHandle = requestAnimationFrame(record);
    window[key] = {
      stop() {
        cancelAnimationFrame(frameHandle);
        observer.disconnect();
        const result = { samples: [...samples], mutationCount };
        delete window[key];
        return result;
      },
    };
  }, probeKey, selectors);
}

export async function stopUiStabilityProbe(browser, options) {
  const result = await browser.execute((key) => window[key]?.stop?.() ?? { samples: [], mutationCount: 0 }, probeKey);
  return summarizeUiStabilitySamples(result.samples, result.mutationCount, options);
}
