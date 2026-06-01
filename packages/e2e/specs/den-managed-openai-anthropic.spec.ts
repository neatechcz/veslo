import { expect } from '@wdio/globals';
import { currentHashRoute, navigateToHash, waitForHashRoute } from '../helpers/app-launcher.js';
// @ts-expect-error -- shared app test utilities are JS-only in this workspace.
import { makeClient, waitForHealthy } from '../../app/scripts/_util.mjs';

function isUnauthenticatedAuthGate(text: string): boolean {
  return text.includes('Sign in to Veslo') && text.includes('Sign in with Browser');
}

async function isDefaultE2EDenAuthSeed(): Promise<boolean> {
  return browser.execute(() => {
    const raw = window.localStorage.getItem('veslo.den.auth') ?? window.sessionStorage.getItem('veslo.den.auth');
    if (!raw) return false;
    try {
      const auth = JSON.parse(raw) as { denApiBase?: unknown; token?: unknown };
      return auth.denApiBase === 'http://127.0.0.1:9' || auth.token === 'veslo-e2e-default-token';
    } catch {
      return false;
    }
  });
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  return haystack.split(needle).length - 1;
}

function readOptionalEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function compactLogText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 2000);
}

function compactBodySnippet(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, 300) : null;
}

type TauriInvokeResult<T> = {
  ok: boolean;
  value?: T;
  error?: string;
};

type VesloServerInfo = {
  running?: boolean;
  baseUrl?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
};

type WorkspaceBootstrapResponse = {
  activeId?: string | null;
  workspaces?: Array<{
    id?: string | null;
    path?: string | null;
    workspaceType?: string | null;
  }>;
};

type EngineInfo = {
  running?: boolean;
  baseUrl?: string | null;
  projectDir?: string | null;
  lastStderr?: string | null;
  lastStdout?: string | null;
  runtime?: string | null;
  opencodeUsername?: string | null;
  opencodePassword?: string | null;
};

type ManagedAiFixtureRequest = {
  pathname?: string | null;
  sessionId?: string | null;
  model?: string | null;
  promptText?: string | null;
};

async function tauriInvoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await browser.executeAsync(
    (
      args: { command: string; payload: Record<string, unknown> },
      done: (value: TauriInvokeResult<unknown>) => void,
    ) => {
      const invoke = (
        window as typeof window & {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;

      if (typeof invoke !== 'function') {
        done({ ok: false, error: 'Tauri invoke bridge is unavailable.' });
        return;
      }

      invoke(args.command, args.payload).then(
        (value) => done({ ok: true, value }),
        (error) =>
          done({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
      );
    },
    { command, payload },
  ) as TauriInvokeResult<T>;

  if (!result.ok) {
    throw new Error(`Tauri invoke failed for ${command}: ${result.error ?? 'unknown error'}`);
  }

  return result.value as T;
}

async function waitForAppShellReady(timeout = 15000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const root = await $('#root');
      if (!(await root.isExisting())) return false;
      const text = await root.getText();
      return text.trim().length > 0;
    },
    {
      timeout,
      timeoutMsg: `App shell did not render within ${timeout}ms`,
    },
  );
}

async function readRootText(): Promise<string> {
  const root = await $('#root');
  return root.getText();
}

async function readMessageTexts(role: 'user' | 'assistant'): Promise<string[]> {
  return browser.execute((messageRole) => {
    return Array.from(document.querySelectorAll(`[data-message-role="${messageRole}"]`))
      .map((element) => element.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean);
  }, role) as Promise<string[]>;
}

async function readTaskErrorDisplays(): Promise<Array<{ text: string; title: string }>> {
  return browser.execute(() => {
    return Array.from(document.querySelectorAll('[title]'))
      .map((element) => ({
        text: element.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        title: element.getAttribute('title')?.replace(/\s+/g, ' ').trim() ?? '',
      }))
      .filter((entry) =>
        entry.title.length > 0 &&
        (entry.text === 'Error' ||
          entry.text === 'Offline' ||
          entry.text.includes('Failed to load tasks') ||
          entry.text.includes('Sandbox is offline')),
      );
  }) as Promise<Array<{ text: string; title: string }>>;
}

async function clickButtonWithText(labels: string[], timeout = 10000): Promise<boolean> {
  const predicates = labels.map((label) => `normalize-space()="${label}"`).join(' or ');
  const buttons = await $$(`//button[${predicates}]`);
  let button: WebdriverIO.Element | null = null;
  for (const candidate of buttons) {
    if (await candidate.isDisplayed().catch(() => false)) {
      button = candidate;
      break;
    }
  }
  if (!button) {
    return false;
  }
  await button.waitForDisplayed({ timeout });
  await browser.waitUntil(async () => button.isEnabled(), {
    timeout,
    interval: 250,
    timeoutMsg: `Button ${labels.join('/')} did not become enabled.`,
  });
  await button.click();
  return true;
}

async function completeFirstRunOnboardingIfVisible(timeout = 120000): Promise<void> {
  const text = await readRootText();
  if (!text.includes('Choose your language') && !text.includes('Vyberte jazyk aplikace')) {
    return;
  }

  await clickButtonWithText(['English']);
  const continued = await clickButtonWithText(['Continue', 'Pokračovat']);
  if (!continued) {
    throw new Error('Language onboarding was visible, but the continue button was not found.');
  }

  await browser.waitUntil(
    async () => {
      const nextText = await readRootText();
      return !nextText.includes('Choose your language') && !nextText.includes('Vyberte jazyk aplikace');
    },
    {
      timeout,
      interval: 250,
      timeoutMsg: 'Language onboarding did not complete.',
    },
  ).catch(async (error) => {
    const currentText = await readRootText().catch(() => '');
    const state = await browser.execute(() => ({
      language: window.localStorage.getItem('veslo.language'),
      onboardingComplete: window.localStorage.getItem('veslo.onboardingComplete'),
      buttons: Array.from(document.querySelectorAll('button')).map((button) => ({
        text: button.textContent?.replace(/\s+/g, ' ').trim() ?? '',
        disabled: button.disabled,
      })),
    })).catch(() => null);
    console.log(`[den-managed-ai-roundtrip] language onboarding still visible text=${compactLogText(currentText)}`);
    console.log(`[den-managed-ai-roundtrip] language onboarding browser state=${JSON.stringify(state)}`);
    throw error;
  });
}

async function waitForExpectedManagedAiAssignment(timeout = 120000): Promise<void> {
  const expectedProvider = readOptionalEnv('VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER');
  const expectedModel = readOptionalEnv('VESLO_E2E_EXPECTED_MANAGED_AI_MODEL');

  if (readOptionalEnv('E2E_MANAGED_AI_GATEWAY_BASE_URL')) {
    return;
  }

  if (!expectedProvider && !expectedModel) {
    return;
  }

  let lastRouteAttempt = 0;
  let lastRefreshAttempt = 0;
  const ensureSettingsRoute = async () => {
    const now = Date.now();
    if (now - lastRouteAttempt < 1000) return;
    lastRouteAttempt = now;
    await navigateToHash('/dashboard/settings');
  };
  const requestManagedAiRefresh = async () => {
    const now = Date.now();
    if (now - lastRefreshAttempt < 3000) return;
    lastRefreshAttempt = now;
    await browser.execute(() => {
      window.dispatchEvent(new Event('focus'));
    });
  };

  await navigateToHash('/dashboard/settings');
  try {
    await browser.waitUntil(
      async () => {
        const url = await browser.getUrl();
        if (!url.includes('#/dashboard/settings')) {
          await ensureSettingsRoute();
          return false;
        }

        const text = normalizeSearchText(await readRootText());
        if (!text.includes('ai access') || !text.includes('managed by the platform admin')) {
          await requestManagedAiRefresh();
          return false;
        }
        if (expectedProvider && !text.includes(normalizeSearchText(expectedProvider))) {
          await requestManagedAiRefresh();
          return false;
        }
        if (expectedModel && !text.includes(normalizeSearchText(expectedModel))) {
          await requestManagedAiRefresh();
          return false;
        }
        return true;
      },
      {
        timeout,
        interval: 500,
        timeoutMsg: `Settings did not show expected managed AI assignment provider=${expectedProvider ?? '(any)'} model=${expectedModel ?? '(any)'} within ${timeout}ms`,
      },
    );
  } catch (error) {
    const url = await browser.getUrl().catch(() => '');
    const text = await readRootText().catch(() => '');
    console.log(`[den-managed-ai-roundtrip] managed AI precheck url=${url}`);
    console.log(`[den-managed-ai-roundtrip] managed AI precheck visible text=${compactLogText(text)}`);
    throw error;
  }
}

async function waitForComposer(timeout = 20000) {
  let textbox = await $('[role="textbox"]');
  try {
    await textbox.waitForExist({ timeout });
    await textbox.waitForDisplayed({ timeout });
  } catch (error) {
    const text = await readRootText().catch(() => '');
    console.log(`[den-managed-ai-roundtrip] composer missing visible text=${compactLogText(text)}`);
    throw error;
  }
  return textbox;
}

async function probeRawSessionApi(engineInfo: EngineInfo | null) {
  const baseUrl = engineInfo?.baseUrl?.trim() ?? '';
  const directory = engineInfo?.projectDir?.trim() ?? '';
  const username = engineInfo?.opencodeUsername?.trim() ?? '';
  const password = engineInfo?.opencodePassword?.trim() ?? '';

  if (!baseUrl || !directory || !username || !password) {
    return null;
  }

  try {
    const client = makeClient({
      baseUrl,
      directory,
      auth: { username, password },
    });
    await waitForHealthy(client, { timeoutMs: 10000, pollMs: 250 });
    const listed = await client.session.list({ directory, limit: 5 });
    const created = await client.session.create({
      title: `[probe] ${Date.now()}`,
      directory,
    });

    return {
      ok: true,
      listedCount: Array.isArray(listed) ? listed.length : null,
      created: Boolean(created?.id),
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probeVesloServerState(vesloServerInfo: VesloServerInfo | null) {
  const baseUrl = vesloServerInfo?.baseUrl?.trim() ?? '';
  const clientToken = vesloServerInfo?.clientToken?.trim() ?? '';
  const hostToken = vesloServerInfo?.hostToken?.trim() ?? '';

  if (!baseUrl || !clientToken) {
    return null;
  }

  try {
    const workspaceResponse = await fetch(`${baseUrl}/workspaces`, {
      headers: {
        authorization: `Bearer ${clientToken}`,
        accept: 'application/json',
      },
    });
    const workspacePayload = (await workspaceResponse.json().catch(() => null)) as
      | { activeId?: string | null; items?: Array<{ id?: string | null; path?: string | null; directory?: string | null }> }
      | null;

    let statusSummary: Record<string, unknown> | null = null;
    if (hostToken) {
      const statusResponse = await fetch(`${baseUrl}/status`, {
        headers: {
          authorization: `Bearer ${hostToken}`,
          accept: 'application/json',
        },
      });
      const statusPayload = (await statusResponse.json().catch(() => null)) as
        | { workspace?: { id?: string | null; path?: string | null } | null; activeWorkspaceId?: string | null; workspaceCount?: number | null }
        | null;
      if (statusPayload) {
        statusSummary = {
          activeWorkspaceId: statusPayload.activeWorkspaceId ?? null,
          workspaceCount: statusPayload.workspaceCount ?? null,
          workspace: statusPayload.workspace
            ? {
                id: statusPayload.workspace.id ?? null,
                path: statusPayload.workspace.path ?? null,
              }
            : null,
        };
      }
    }

    return {
      ok: workspaceResponse.ok,
      activeId: workspacePayload?.activeId ?? null,
      workspaceCount: Array.isArray(workspacePayload?.items) ? workspacePayload.items.length : null,
      items: Array.isArray(workspacePayload?.items)
        ? workspacePayload.items.map((item) => ({
            id: item.id ?? null,
            path: item.path ?? item.directory ?? null,
          }))
        : [],
      status: statusSummary,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function installFetchProbe(): Promise<void> {
  await browser.execute(() => {
    const root = window as typeof window & {
      __vesloFetchProbeInstalled?: boolean;
      __vesloFetchProbeLogs?: Array<Record<string, unknown>>;
    };
    if (root.__vesloFetchProbeInstalled) {
      root.__vesloFetchProbeLogs = [];
      return;
    }

    const originalFetch = window.fetch.bind(window);
    root.__vesloFetchProbeInstalled = true;
    root.__vesloFetchProbeLogs = [];
    const compactBodySnippet = (value: unknown) => {
      if (typeof value !== 'string') {
        return null;
      }
      const trimmed = value.replace(/\s+/g, ' ').trim();
      return trimmed ? trimmed.slice(0, 300) : null;
    };

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const startedAt = Date.now();
      const request = input instanceof Request ? input : null;
      const method = init?.method ?? request?.method ?? 'GET';
      const url = String(input instanceof Request ? input.url : input);
      const rawBody =
        typeof init?.body === 'string'
          ? init.body
          : null;
      const bodySnippet = compactBodySnippet(rawBody);
      let targetUrl: string | null = null;
      let targetMethod: string | null = null;
      if (rawBody && url.includes('plugin%3Ahttp%7Cfetch')) {
        try {
          const parsed = JSON.parse(rawBody) as {
            clientConfig?: { url?: string; method?: string };
          };
          targetUrl = parsed.clientConfig?.url ?? null;
          targetMethod = parsed.clientConfig?.method ?? null;
        } catch {
          // ignore
        }
      }

      try {
        const response = await originalFetch(input, init);
        const logs = root.__vesloFetchProbeLogs ?? [];
        logs.push({
          at: new Date().toISOString(),
          method,
          url,
          targetUrl,
          targetMethod,
          status: response.status,
          ok: response.ok,
          durationMs: Date.now() - startedAt,
          bodySnippet,
        });
        if (logs.length > 80) logs.splice(0, logs.length - 80);
        root.__vesloFetchProbeLogs = logs;
        return response;
      } catch (error) {
        const logs = root.__vesloFetchProbeLogs ?? [];
        logs.push({
          at: new Date().toISOString(),
          method,
          url,
          targetUrl,
          targetMethod,
          error: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
          bodySnippet,
        });
        if (logs.length > 80) logs.splice(0, logs.length - 80);
        root.__vesloFetchProbeLogs = logs;
        throw error;
      }
    };
  });
}

async function openPrivateWorkspaceComposerIfVisible(timeout = 30000): Promise<void> {
  const text = await readRootText();
  if (!text.includes('Start a chat') && !text.includes('Začít chat')) {
    return;
  }

  const newSessionButton = await $(
    '//h3[normalize-space()="Start a chat" or normalize-space()="Začít chat"]/following::button[normalize-space()="Chat" or normalize-space()="聊天"][1]',
  );
  await newSessionButton.waitForDisplayed({ timeout });
  await browser.waitUntil(async () => newSessionButton.isEnabled(), {
    timeout,
    interval: 250,
    timeoutMsg: 'Private workspace Chat button did not become enabled.',
  });
  await newSessionButton.click();
  await waitForComposer(timeout);
}

async function ensureLocalVesloServerReady(timeout = 60000): Promise<void> {
  await browser.setTimeout({ script: timeout });
  await tauriInvoke('veslo_server_restart');

  await browser.waitUntil(
    async () => {
      const info = await tauriInvoke<VesloServerInfo>('veslo_server_info').catch(() => null);
      return Boolean(info?.running && info?.baseUrl && info?.clientToken);
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `Local Veslo server did not become ready within ${timeout}ms`,
    },
  );

  await browser.execute(() => {
    window.dispatchEvent(new Event('focus'));
  });
}

async function readActiveLocalWorkspacePath(): Promise<string> {
  const bootstrap = await tauriInvoke<WorkspaceBootstrapResponse>('workspace_bootstrap');
  const workspaces = Array.isArray(bootstrap.workspaces) ? bootstrap.workspaces : [];
  const activeWorkspace =
    workspaces.find((workspace) => workspace.id && workspace.id === bootstrap.activeId) ??
    workspaces.find((workspace) => workspace.workspaceType === 'local' && workspace.path?.trim());
  const workspacePath =
    activeWorkspace?.workspaceType === 'local' && activeWorkspace.path ? activeWorkspace.path.trim() : '';

  if (!workspacePath) {
    throw new Error(
      `No active local workspace available for engine startup (activeId=${bootstrap.activeId ?? 'none'}, workspaceCount=${workspaces.length}).`,
    );
  }

  return workspacePath;
}

async function ensureLocalEngineReady(timeout = 360000): Promise<void> {
  const workspacePath = await readActiveLocalWorkspacePath();
  const startedAt = Date.now();
  const normalizeWorkspacePath = (value: string | null | undefined) =>
    (value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');

  const normalizedWorkspacePath = normalizeWorkspacePath(workspacePath);
  console.log(`[den-managed-ai-roundtrip] waiting for local engine for ${workspacePath}`);
  await browser.setTimeout({ script: timeout });

  try {
    await browser.waitUntil(
      async () => {
        const info = await tauriInvoke<EngineInfo>('engine_info').catch(() => null);
        return Boolean(
          info?.running &&
            normalizeWorkspacePath(info?.projectDir) === normalizedWorkspacePath,
        );
      },
      {
        timeout,
        interval: 500,
        timeoutMsg: `Local engine did not report running for ${workspacePath} within ${timeout}ms`,
      },
    );
  } catch (error) {
    const info = await tauriInvoke<EngineInfo>('engine_info').catch(() => null);
    console.log(`[den-managed-ai-roundtrip] local engine wait failed info=${JSON.stringify(info)}`);
    throw error;
  }

  await tauriInvoke('veslo_server_restart');
  await browser.execute(() => {
    window.dispatchEvent(new Event('focus'));
  });
  console.log(`[den-managed-ai-roundtrip] local engine ready in ${Date.now() - startedAt}ms`);

  await browser.refresh();
  await waitForAppShellReady(30000);
  await completeFirstRunOnboardingIfVisible();
}

async function waitForSessionRuntimeReady(timeout = 60000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const text = await readRootText();
      if (text.includes('Loading tasks')) return false;
      const state = await browser.execute(() => ({
        baseUrl: window.localStorage.getItem('veslo.baseUrl') ?? '',
        defaultModel: window.localStorage.getItem('veslo.defaultModel') ?? '',
      }));
      return state.baseUrl.startsWith('http://127.0.0.1:') && state.defaultModel.includes('gpt-5.4');
    },
    {
      timeout,
      interval: 500,
      timeoutMsg: `Session runtime did not reconnect within ${timeout}ms`,
    },
  );
}

async function setComposerText(text: string): Promise<void> {
  const textbox = await waitForComposer();
  await textbox.click();
  await textbox.setValue(text);
  await browser.waitUntil(
    async () => browser.execute((element: HTMLElement, value: string) => element.textContent === value, textbox, text),
    {
      timeout: 10000,
      timeoutMsg: 'Composer text was not reflected in the editable node after input.',
    },
  );
}

async function clickSend(): Promise<void> {
  const textbox = await waitForComposer();
  await textbox.click();
  const sendButtons = await $$([
    'button[title="Send"]',
    'button[aria-label="Send"]',
    'button[title="Odeslat"]',
    'button[aria-label="Odeslat"]',
    'button[title="Queue message"]',
    'button[aria-label="Queue message"]',
    'button[title="Zařadit zprávu"]',
    'button[aria-label="Zařadit zprávu"]',
    'button[title="加入队列"]',
    'button[aria-label="加入队列"]',
  ].join(', '));
  let sendButton: WebdriverIO.Element | null = null;
  for (const candidate of sendButtons) {
    if (await candidate.isDisplayed().catch(() => false)) {
      sendButton = candidate;
      break;
    }
  }
  if (!sendButton) {
    throw new Error('Send button was not visible in the composer.');
  }

  const before = await browser.execute((editor: HTMLElement) => ({
    activeElementIsEditor: document.activeElement === editor,
    editorText: editor.textContent ?? '',
  }), textbox);
  console.log(`[den-managed-ai-roundtrip] before send=${JSON.stringify(before)}`);

  await sendButton.waitForDisplayed({ timeout: 10000 });
  await browser.waitUntil(async () => sendButton.isEnabled(), {
    timeout: 10000,
    interval: 250,
    timeoutMsg: 'Send button did not become enabled.',
  });
  await sendButton.click();

  await browser.pause(1000);
  const after = await browser.execute((editor: HTMLElement) => ({
    activeElementIsEditor: document.activeElement === editor,
    editorText: editor.textContent ?? '',
  }), textbox);
  console.log(`[den-managed-ai-roundtrip] after send=${JSON.stringify(after)}`);
}

async function waitForNewAssistantResponse(
  baselineAssistantMessages: string[],
  token: string,
  timeout = 120000,
): Promise<string> {
  let assistantResponse = '';
  await browser.waitUntil(
    async () => {
      const assistantMessages = await readMessageTexts('assistant');
      const newMessages = assistantMessages.slice(baselineAssistantMessages.length);
      assistantResponse =
        newMessages.find((message) => {
          const normalized = normalizeSearchText(message);
          return (
            message.length > 0 &&
            !normalized.includes('server unavailable') &&
            !normalized.includes('failed to') &&
            !normalized.includes('gateway error')
          );
        }) ?? '';
      return assistantResponse.length > 0;
    },
    {
      timeout,
      interval: 1000,
      timeoutMsg: `Managed AI did not render a new assistant response for token ${token} within ${timeout}ms`,
    },
  );
  return assistantResponse;
}

async function sendPromptAndWaitForAssistant(prompt: string, token: string): Promise<string> {
  const baselineAssistantMessages = await readMessageTexts('assistant');
  await setComposerText(prompt);
  await clickSend();
  return waitForNewAssistantResponse(baselineAssistantMessages, token);
}

function extractSessionIdFromHash(hash: string): string {
  const match = hash.match(/^#\/session\/([^/?#]+)/);
  if (!match?.[1]) {
    throw new Error(`Expected a selected session route after managed AI send, got ${hash || '(empty hash)'}`);
  }
  return decodeURIComponent(match[1]);
}

async function waitForSelectedSessionHash(timeout = 30000): Promise<string> {
  await browser.waitUntil(
    async () => (await currentHashRoute()).startsWith('#/session/'),
    {
      timeout,
      interval: 250,
      timeoutMsg: `A newly sent prompt did not select a session route within ${timeout}ms`,
    },
  );
  return currentHashRoute();
}

async function readManagedAiFixtureRequests(): Promise<ManagedAiFixtureRequest[] | null> {
  const baseUrl = readOptionalEnv('E2E_MANAGED_AI_GATEWAY_BASE_URL');
  if (!baseUrl) {
    return null;
  }
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/__e2e/requests`);
  if (!response.ok) {
    throw new Error(`Failed to read managed AI fixture requests: ${response.status} ${response.statusText}`);
  }
  const payload = await response.json() as { requests?: ManagedAiFixtureRequest[] };
  return Array.isArray(payload.requests) ? payload.requests : [];
}

async function expectManagedAiFixtureObservedSession(tokens: string[], sessionId: string): Promise<void> {
  if (!readOptionalEnv('E2E_MANAGED_AI_GATEWAY_BASE_URL')) {
    return;
  }

  let matchingRequests: ManagedAiFixtureRequest[] = [];
  await browser.waitUntil(
    async () => {
      const requests = await readManagedAiFixtureRequests();
      matchingRequests = (requests ?? []).filter((request) =>
        request.pathname === '/providers/codex_oauth/v1/chat/completions' &&
        tokens.some((token) => request.promptText?.includes(token)),
      );
      return tokens.every((token) =>
        matchingRequests.some((request) => request.promptText?.includes(token)),
      );
    },
    {
      timeout: 30000,
      interval: 500,
      timeoutMsg: `Managed AI fixture did not observe both new-chat and existing-chat requests while UI stayed on session ${sessionId}. Observed=${JSON.stringify(matchingRequests)}`,
    },
  );

  expect(matchingRequests.length).toBeGreaterThanOrEqual(tokens.length);
  expect(matchingRequests.every((request) => typeof request.sessionId === 'string' && request.sessionId.length > 0)).toBe(true);
  expect(matchingRequests.every((request) => request.model === 'gpt-5.4')).toBe(true);
}

describe('DEN-managed AI roundtrip', () => {
  it('should answer in a newly created managed chat and again after reopening the existing chat', async function () {
    this.timeout(720000);

    await waitForAppShellReady();
    const initialText = await readRootText();
    if (isUnauthenticatedAuthGate(initialText)) {
      console.warn('[den-managed-ai-roundtrip] Skipping because the desktop profile is still unauthenticated. Seed or sign in before running this spec.');
      this.skip();
    }
    if (await isDefaultE2EDenAuthSeed()) {
      console.warn('[den-managed-ai-roundtrip] Skipping because the desktop profile is using the default non-live E2E auth seed.');
      this.skip();
    }

    await completeFirstRunOnboardingIfVisible();
    await navigateToHash('/session');
    await openPrivateWorkspaceComposerIfVisible();
    await waitForComposer();
    await ensureLocalVesloServerReady();
    await waitForExpectedManagedAiAssignment();
    await navigateToHash('/session');
    await waitForComposer();
    await waitForComposer();
    await installFetchProbe();

    const expectedProvider = readOptionalEnv('VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER') ?? 'managed-ai';
    const tokenBase = `${expectedProvider.replace(/[^a-z0-9_-]/gi, '-').toLowerCase()}-${Date.now()}`;
    const newChatToken = `${tokenBase}-new`;
    const existingChatToken = `${tokenBase}-existing`;
    const newChatPrompt = `Live Veslo desktop E2E new chat check ${newChatToken}. Reply with one short sentence.`;
    const existingChatPrompt = `Live Veslo desktop E2E existing chat check ${existingChatToken}. Reply with one short sentence.`;

    let newChatAssistantResponse = '';
    let existingChatAssistantResponse = '';
    let sessionId = '';
    try {
      newChatAssistantResponse = await sendPromptAndWaitForAssistant(newChatPrompt, newChatToken);
      const sessionHash = await waitForSelectedSessionHash();
      sessionId = extractSessionIdFromHash(sessionHash);

      await navigateToHash('/dashboard/settings');
      await navigateToHash(`/session/${sessionId}`);
      await waitForHashRoute(`#/session/${sessionId}`, 30000);
      await waitForComposer();

      existingChatAssistantResponse = await sendPromptAndWaitForAssistant(existingChatPrompt, existingChatToken);
      await expectManagedAiFixtureObservedSession([newChatToken, existingChatToken], sessionId);
    } catch (error) {
      const text = await readRootText().catch(() => '');
      const taskErrorDisplays = await readTaskErrorDisplays().catch(() => []);
      const engineInfo = await tauriInvoke<EngineInfo>('engine_info').catch(() => null);
      const vesloServerInfo = await tauriInvoke<VesloServerInfo>('veslo_server_info').catch(() => null);
      const rawSessionApiProbe = await probeRawSessionApi(engineInfo).catch(() => null);
      const vesloServerStateProbe = await probeVesloServerState(vesloServerInfo).catch(() => null);
      const perfLogs = await browser.execute(() => {
        const root = window as typeof window & { __vesloPerfLogs?: unknown[] };
        return Array.isArray(root.__vesloPerfLogs) ? root.__vesloPerfLogs.slice(-20) : [];
      }).catch(() => []);
      const fetchLogs = await browser.execute(() => {
        const root = window as typeof window & { __vesloFetchProbeLogs?: unknown[] };
        return Array.isArray(root.__vesloFetchProbeLogs) ? root.__vesloFetchProbeLogs.slice(-40) : [];
      }).catch(() => []);
      const sendTrace = await browser.execute(() => {
        const root = window as typeof window & { __vesloSendTrace?: unknown[] };
        return Array.isArray(root.__vesloSendTrace) ? root.__vesloSendTrace.slice(-60) : [];
      }).catch(() => []);
      const workspaceActivateLog = await browser.execute(() => {
        const root = window as typeof window & { __wsActivateLog?: string };
        return typeof root.__wsActivateLog === 'string' ? root.__wsActivateLog : '';
      }).catch(() => '');
      const browserState = await browser.execute(() => {
        const storage = window.localStorage;
        return {
          hash: window.location.hash,
          baseUrl: storage.getItem('veslo.baseUrl'),
          startupPreference: storage.getItem('veslo.startupPreference'),
          defaultModel: storage.getItem('veslo.defaultModel'),
          onboardingComplete: storage.getItem('veslo.onboardingComplete'),
        };
      }).catch(() => null);
      const safeEngineInfo = engineInfo
        ? {
            running: engineInfo.running ?? false,
            runtime: engineInfo.runtime ?? null,
            projectDir: engineInfo.projectDir ?? null,
            baseUrl: engineInfo.baseUrl ?? null,
            lastStdout: compactLogText(engineInfo.lastStdout ?? ''),
            lastStderr: compactLogText(engineInfo.lastStderr ?? ''),
          }
        : null;
      const safeVesloServerInfo = vesloServerInfo
        ? {
            running: vesloServerInfo.running ?? false,
            baseUrl: vesloServerInfo.baseUrl ?? null,
          }
        : null;
      const managedAiFixtureRequests = await readManagedAiFixtureRequests().catch(() => null);
      const interestingFetchLogs = Array.isArray(fetchLogs)
        ? fetchLogs.filter((entry) => {
            if (!entry || typeof entry !== 'object') return false;
            const record = entry as Record<string, unknown>;
            const targetUrl = typeof record.targetUrl === 'string' ? record.targetUrl : '';
            return (
              targetUrl.includes('/session') ||
              targetUrl.includes('/event') ||
              targetUrl.includes('/health') ||
              targetUrl.includes('/config')
            );
          })
        : [];
      console.log(`[den-managed-ai-roundtrip] final new-chat token occurrences=${countOccurrences(text, newChatToken)}`);
      console.log(`[den-managed-ai-roundtrip] final existing-chat token occurrences=${countOccurrences(text, existingChatToken)}`);
      console.log(`[den-managed-ai-roundtrip] final visible text=${compactLogText(text)}`);
      console.log(`[den-managed-ai-roundtrip] browser state=${JSON.stringify(browserState)}`);
      console.log(`[den-managed-ai-roundtrip] task error displays=${JSON.stringify(taskErrorDisplays)}`);
      console.log(`[den-managed-ai-roundtrip] engine info=${JSON.stringify(safeEngineInfo)}`);
      console.log(`[den-managed-ai-roundtrip] veslo server info=${JSON.stringify(safeVesloServerInfo)}`);
      console.log(`[den-managed-ai-roundtrip] veslo server state probe=${compactLogText(JSON.stringify(vesloServerStateProbe))}`);
      console.log(`[den-managed-ai-roundtrip] raw session api probe=${JSON.stringify(rawSessionApiProbe)}`);
      console.log(`[den-managed-ai-roundtrip] managed AI fixture requests=${compactLogText(JSON.stringify(managedAiFixtureRequests))}`);
      console.log(`[den-managed-ai-roundtrip] fetch logs=${compactLogText(JSON.stringify(interestingFetchLogs))}`);
      console.log(`[den-managed-ai-roundtrip] send trace=${compactLogText(JSON.stringify(sendTrace))}`);
      console.log(`[den-managed-ai-roundtrip] workspace activate log=${compactLogText(workspaceActivateLog)}`);
      console.log(`[den-managed-ai-roundtrip] perf logs=${compactLogText(JSON.stringify(perfLogs))}`);
      throw error;
    }

    const text = await readRootText();
    const userMessages = await readMessageTexts('user');
    const assistantResponses = [newChatAssistantResponse, existingChatAssistantResponse];
    console.log(`[den-managed-ai-roundtrip] new chat assistant response=${compactLogText(newChatAssistantResponse)}`);
    console.log(`[den-managed-ai-roundtrip] existing chat assistant response=${compactLogText(existingChatAssistantResponse)}`);
    expect(sessionId.length).toBeGreaterThan(0);
    expect(userMessages.some((message) => message.includes(newChatToken))).toBe(true);
    expect(userMessages.some((message) => message.includes(existingChatToken))).toBe(true);
    for (const assistantResponse of assistantResponses) {
      const assistantResponseLower = assistantResponse.toLowerCase();
      expect(assistantResponse.length).toBeGreaterThan(0);
      expect(assistantResponseLower).not.toContain('authentication failed');
      expect(assistantResponseLower).not.toContain('invalid bearer token');
      expect(assistantResponseLower).not.toContain('unauthorized');
    }
    expect(text.toLowerCase()).not.toContain('server unavailable');
    expect(text.toLowerCase()).not.toContain('gateway error');
  });
});
