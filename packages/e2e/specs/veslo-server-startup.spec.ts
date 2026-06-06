import { expect } from '@wdio/globals';

type VesloServerInfo = {
  running: boolean;
  baseUrl: string | null;
  clientToken: string | null;
  lastStderr: string | null;
};

type EngineInfo = {
  running: boolean;
  runtime: string;
  baseUrl: string | null;
  projectDir: string | null;
  opencodeUsername: string | null;
  opencodePassword: string | null;
};

type OpenCodeRouterInfo = {
  running: boolean;
  opencodeUrl: string | null;
  healthPort: number | null;
  lastStderr: string | null;
};

type WorkspaceListResponse = {
  items?: Array<{ id?: string; baseUrl?: string | null }>;
  activeId?: string | null;
};

type WorkspaceInfo = {
  id: string;
  path: string;
  directory?: string | null;
};

type WorkspaceBootstrap = {
  activeId: string;
  workspaces: WorkspaceInfo[];
};

async function tauriInvoke<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = await browser.executeAsync(
    (
      args: { command: string; payload: Record<string, unknown> },
      done: (value: { ok: boolean; value?: unknown; error?: string }) => void,
    ) => {
      const invoke = (
        window as typeof window & {
          __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };
        }
      ).__TAURI_INTERNALS__?.invoke;

      if (typeof invoke !== 'function') {
        done({ ok: false, error: 'Tauri invoke bridge is unavailable' });
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
  ) as { ok: boolean; value?: T; error?: string };

  if (!result.ok) {
    throw new Error(`Tauri invoke failed for ${command}: ${result.error ?? 'unknown error'}`);
  }

  return result.value as T;
}

function trimBaseUrl(value: string | null | undefined): string {
  return (value ?? '').trim().replace(/\/+$/, '');
}

function trimToken(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function isLoopbackHttpUrl(value: string | null | undefined): boolean {
  const trimmed = trimBaseUrl(value);
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(trimmed);
}

function expectLoopbackHttpUrl(value: string | null | undefined, label: string): void {
  if (!isLoopbackHttpUrl(value)) {
    throw new Error(`${label} should be a loopback HTTP URL, got ${value ?? '<empty>'}`);
  }
  expect(isLoopbackHttpUrl(value)).toBe(true);
}

async function readActiveWorkspaceDirectory(): Promise<string> {
  const bootstrap = await tauriInvoke<WorkspaceBootstrap>('workspace_bootstrap');
  const activeWorkspace = bootstrap.workspaces.find((workspace) => workspace.id === bootstrap.activeId);
  const directory = trimToken(activeWorkspace?.directory) || trimToken(activeWorkspace?.path);
  if (!activeWorkspace || !directory) {
    throw new Error('Active workspace is not ready yet');
  }
  return directory;
}

async function waitForVesloServerReady(timeoutMs = 45_000): Promise<VesloServerInfo> {
  let latest: VesloServerInfo | null = null;

  await browser.waitUntil(
    async () => {
      try {
        const info = await tauriInvoke<VesloServerInfo>('veslo_server_info');
        latest = info;

        if (!info.running) return false;
        const baseUrl = trimBaseUrl(info.baseUrl);
        const token = trimToken(info.clientToken);
        if (!baseUrl || !token) return false;

        const response = await fetch(`${baseUrl}/health`);
        if (!response.ok) return false;

        const health = (await response.json()) as { ok?: boolean };
        return health.ok === true;
      } catch {
        return false;
      }
    },
    {
      timeout: timeoutMs,
      interval: 500,
      timeoutMsg:
        'Veslo server did not become healthy after desktop launch (veslo_server_info stayed disconnected/unhealthy).',
    },
  );

  if (!latest) {
    throw new Error('Veslo server readiness check returned no status data.');
  }

  return latest;
}

describe('Veslo server startup handshake', () => {
  it('starts and accepts authenticated workspace requests on desktop launch', async () => {
    const info = await waitForVesloServerReady();
    const baseUrl = trimBaseUrl(info.baseUrl);
    const token = trimToken(info.clientToken);

    expect(info.running).toBe(true);
    expect(Boolean(baseUrl)).toBe(true);
    expect(Boolean(token)).toBe(true);

    const workspacesResponse = await fetch(`${baseUrl}/workspaces`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const workspacesPayload = (await workspacesResponse.json()) as WorkspaceListResponse;

    expect(workspacesResponse.ok).toBe(true);
    expect(Array.isArray(workspacesPayload.items)).toBe(true);
    expect((workspacesPayload.items ?? []).length).toBeGreaterThan(0);
    expect(Boolean((workspacesPayload.activeId ?? '').trim())).toBe(true);
  });

  it('starts local OpenCode sidecars with loopback internal URLs', async () => {
    const directory = await readActiveWorkspaceDirectory();

    await tauriInvoke<EngineInfo>('engine_start', {
      projectDir: directory,
      preferSidecar: true,
      runtime: 'veslo-orchestrator',
      workspacePaths: [directory],
    });

    const readySidecars: {
      value?: {
        engineInfo: EngineInfo;
        routerInfo: OpenCodeRouterInfo;
        serverInfo: VesloServerInfo;
      };
    } = {};

    await browser.waitUntil(
      async () => {
        try {
          const engineInfo = await tauriInvoke<EngineInfo>('engine_info');
          const routerInfo = await tauriInvoke<OpenCodeRouterInfo>('opencodeRouter_info');
          const serverInfo = await tauriInvoke<VesloServerInfo>('veslo_server_info');

          const ready =
            engineInfo.running &&
            routerInfo.running &&
            serverInfo.running &&
            isLoopbackHttpUrl(engineInfo.baseUrl) &&
            isLoopbackHttpUrl(routerInfo.opencodeUrl) &&
            isLoopbackHttpUrl(serverInfo.baseUrl);
          if (ready) {
            readySidecars.value = { engineInfo, routerInfo, serverInfo };
          }
          return ready;
        } catch {
          return false;
        }
      },
      {
        timeout: 120_000,
        interval: 500,
        timeoutMsg: 'Desktop local OpenCode sidecars did not report loopback URLs in time.',
      },
    );

    if (!readySidecars.value) {
      throw new Error('Desktop local OpenCode sidecars became ready without status details.');
    }

    const { engineInfo, routerInfo, serverInfo } = readySidecars.value;

    expect(engineInfo?.runtime).toBe('veslo-orchestrator');
    expectLoopbackHttpUrl(engineInfo?.baseUrl, 'engine baseUrl');
    expectLoopbackHttpUrl(routerInfo?.opencodeUrl, 'opencodeRouter opencodeUrl');
    expectLoopbackHttpUrl(serverInfo?.baseUrl, 'veslo server baseUrl');

    const serverBaseUrl = trimBaseUrl(serverInfo?.baseUrl);
    const token = trimToken(serverInfo?.clientToken);
    const workspacesResponse = await fetch(`${serverBaseUrl}/workspaces`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const workspacesPayload = (await workspacesResponse.json()) as WorkspaceListResponse;
    const activeWorkspace = (workspacesPayload.items ?? []).find(
      (workspace) => workspace.id === workspacesPayload.activeId,
    );

    expect(workspacesResponse.ok).toBe(true);
    expectLoopbackHttpUrl(activeWorkspace?.baseUrl, 'veslo workspace OpenCode baseUrl');

    if (routerInfo?.healthPort) {
      const routerHealthResponse = await fetch(`http://127.0.0.1:${routerInfo.healthPort}/health`);
      const routerHealth = (await routerHealthResponse.json()) as { opencode?: { url?: string } };
      expect(routerHealthResponse.ok).toBe(true);
      expectLoopbackHttpUrl(routerHealth.opencode?.url, 'opencodeRouter health opencode.url');
    }
  });
});
