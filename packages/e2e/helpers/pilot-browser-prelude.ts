export const PILOT_BROWSER_PRELUDE_SCHEMA = 'veslo-tauri-pilot-browser-prelude/v1';
export const PILOT_BROWSER_PRELUDE_STORAGE_KEY = 'veslo.tauriPilot.browserPrelude.v1';

/**
 * Browser-only primitives shared by Pilot scenarios. They intentionally stop
 * before business actions: scenarios retain their own visible user flow and
 * must use a real Pilot click for submit.
 */
export function buildPilotBrowserPreludeScript(): string {
  const installScript = `(() => {
  const schema = ${JSON.stringify(PILOT_BROWSER_PRELUDE_SCHEMA)};
  const existing = window.__vesloPilotE2E;
  if (existing && existing.schema === schema) return { schema, reused: true };

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const normalize = (value) => String(value ?? '').trim().replace(/\\s+/g, ' ');
  const assert = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const withTimeout = async (promise, timeoutMs, message) => {
    let timeoutId = null;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    }
  };
  const waitUntil = async (predicate, options = {}) => {
    const timeout = options.timeout ?? 10000;
    const interval = options.interval ?? 200;
    const deadline = Date.now() + timeout;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await predicate();
      if (latest) return latest;
      await sleep(interval);
    }
    throw new Error((options.message ?? 'Condition was not met') + '. Latest=' + JSON.stringify(latest));
  };
  const invoke = async (command, payload = {}, timeout = 90000) => {
    const bridge = window.__TAURI_INTERNALS__?.invoke;
    assert(typeof bridge === 'function', 'Tauri invoke bridge is unavailable.');
    return await withTimeout(
      bridge(command, payload),
      timeout,
      'Tauri command ' + command + ' did not resolve within ' + timeout + 'ms',
    );
  };
  const visible = (element) => {
    if (!(element instanceof HTMLElement)) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return Boolean(element.offsetParent) && rect.width > 0 && rect.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden';
  };
  const text = (element) => normalize(element?.innerText || element?.textContent || '');
  const findVisibleButton = (labels, root = document) => {
    const expected = labels.map(normalize).filter(Boolean);
    return Array.from(root.querySelectorAll('button')).find((button) => {
      if (!visible(button) || button.disabled) return false;
      const values = [button.textContent, button.title, button.getAttribute('aria-label')]
        .map(normalize)
        .filter(Boolean);
      return expected.some((label) => values.some((value) => value === label || value.includes(label)));
    }) || null;
  };
  const getComposer = () => {
    const editors = Array.from(document.querySelectorAll('[role="textbox"][contenteditable="true"]'));
    return editors.find(visible) || null;
  };
  const insertContenteditableThroughBrowser = (editor, value) => {
    assert(editor instanceof HTMLElement, 'Expected a contenteditable composer element.');
    assert(editor.getAttribute('contenteditable') === 'true', 'Expected a contenteditable composer element.');
    const content = String(value ?? '');
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    assert(selection, 'Browser selection is unavailable for the contenteditable composer.');
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);
    const command = content ? 'insertText' : 'delete';
    if (!document.execCommand(command, false, content || null)) {
      throw new Error('WebView rejected the contenteditable browser edit.');
    }
    return content;
  };
  const installContenteditableTypeAdapter = () => {
    const pilot = window.__PILOT__;
    assert(pilot && typeof pilot.type === 'function', 'Tauri Pilot type bridge is unavailable.');
    if (pilot.__vesloContenteditableTypeAdapter) return { reused: true };

    const originalType = pilot.type.bind(pilot);
    pilot.type = (params) => {
      const target = params?.selector
        ? document.querySelector(params.selector)
        : params?.ref
          ? pilot.resolve(params.ref)
          : null;
      if (!(target instanceof HTMLElement) || !target.isContentEditable) {
        return originalType(params);
      }

      target.focus({ preventScroll: true });
      const selection = window.getSelection();
      assert(selection, 'Browser selection is unavailable for the contenteditable composer.');
      if (!target.contains(selection.anchorNode)) {
        const range = document.createRange();
        range.selectNodeContents(target);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (!document.execCommand('insertText', false, String(params?.text ?? ''))) {
        throw new Error('WebView rejected Pilot contenteditable text edit.');
      }
      return { ok: true, inputPath: 'browser-contenteditable-edit' };
    };
    Object.defineProperty(pilot, '__vesloContenteditableTypeAdapter', { value: true });
    return { reused: false };
  };
  const safeScenarioKey = (name) => normalize(name).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 96) || 'scenario';
  const marker = (scenario, state, payload = null) => {
    const key = safeScenarioKey(scenario);
    const selector = '[data-testid="pilot-prelude-' + key + '-' + state + '"]';
    document.querySelector(selector)?.remove();
    const element = document.createElement('pre');
    element.dataset.testid = 'pilot-prelude-' + key + '-' + state;
    element.style.display = 'none';
    element.textContent = JSON.stringify({
      schema,
      scenario: key,
      state,
      at: new Date().toISOString(),
      payload,
    });
    document.body.append(element);
    return element;
  };
  const recentTraceSummary = () => {
    const trace = Array.isArray(window.__vesloSendWorkflowTrace) ? window.__vesloSendWorkflowTrace : [];
    return trace.slice(-40).map((entry) => ({
      id: Number(entry?.id ?? 0) || null,
      at: typeof entry?.at === 'string' ? entry.at : null,
      event: normalize(entry?.event) || null,
      source: normalize(entry?.source) || null,
      workspaceId: normalize(entry?.workspaceId) || null,
      targetWorkspaceId: normalize(entry?.targetWorkspaceId) || null,
      ok: entry?.ok === true ? true : entry?.ok === false ? false : null,
      durationMs: Number.isFinite(Number(entry?.durationMs)) ? Number(entry.durationMs) : null,
    }));
  };

  window.__vesloPilotE2E = Object.freeze({
    schema,
    sleep,
    normalize,
    assert,
    withTimeout,
    waitUntil,
    invoke,
    visible,
    text,
    findVisibleButton,
    getComposer,
    insertContenteditableThroughBrowser,
    installContenteditableTypeAdapter,
    progress: (scenario, stage, detail = null) => marker(scenario, 'progress', { stage, detail }),
    finishScenario: (scenario, payload = null) => marker(scenario, 'complete', payload),
    failScenario: (scenario, error, payload = null) => marker(scenario, 'error', {
      message: normalize(error?.message ?? error).slice(0, 2000),
      payload,
    }),
    recentTraceSummary,
  });
  return { schema, reused: false };
})()`;
  return `(() => {
  try {
    window.sessionStorage?.setItem(
      ${JSON.stringify(PILOT_BROWSER_PRELUDE_STORAGE_KEY)},
      ${JSON.stringify(installScript)},
    );
  } catch {
    // A disabled session store must not make the initial Pilot prelude fail.
  }
  return ${installScript};
})()`;
}
