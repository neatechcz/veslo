import { expect } from '@wdio/globals';

type VesloServerInfo = {
  running: boolean;
  baseUrl: string | null;
  clientToken: string | null;
  lastStderr: string | null;
};

type WorkspaceListResponse = {
  items?: unknown[];
  activeId?: string | null;
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
});
