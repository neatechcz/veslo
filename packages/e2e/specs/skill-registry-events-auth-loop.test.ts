import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  E2E_SKILL_REGISTRY_USER_ID,
  startSkillRegistryFixture,
  stopSkillRegistryFixture,
} from '../helpers/skill-registry-fixture.js';
import {
  startStandaloneVesloServerProfile,
  type StandaloneVesloServerProfile,
} from '../helpers/veslo-server-process.js';

type ListenerOptions = {
  onUnauthorized?: (error: unknown) => void | Promise<void>;
};

type MinimalVesloServerClient = {
  baseUrl: string;
  token: string;
  syncWorkspaceSkillMaterialization: () => Promise<{ synced: boolean; reloadRequired: boolean }>;
  syncGlobalSkillMaterialization: () => Promise<{ synced: boolean; reloadRequired: boolean }>;
};

const appRequire = createRequire(new URL('../../app/package.json', import.meta.url));

async function flushEffects() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
}

async function loadAppOrchestrator() {
  return import('../../app/src/app/context/' + 'skill-registry-orchestrator.js') as Promise<{
    createSkillRegistryOrchestrator: (deps: Record<string, unknown>) => unknown;
  }>;
}

async function loadAppSolidRoot() {
  return import(pathToFileURL(appRequire.resolve('solid-js')).href) as Promise<{
    createRoot: (fn: (dispose: () => void) => void | Promise<void>) => void | Promise<void>;
  }>;
}

function createListenerCapture() {
  let listenerOptions: ListenerOptions | null = null;
  let started = 0;
  let stopped = 0;
  const createListener = (options: ListenerOptions) => {
    listenerOptions = options;
    return {
      start() {
        started += 1;
      },
      stop() {
        stopped += 1;
      },
      pollNow: async () => {},
      getState: () => ({
        running: started > stopped,
        cursor: null,
        revision: null,
        inFlight: false,
      }),
    };
  };

  return {
    createListener,
    get options() {
      assert.ok(listenerOptions, 'expected listener options to be captured');
      return listenerOptions;
    },
    get started() {
      return started;
    },
    get stopped() {
      return stopped;
    },
  };
}

function denAuth(registryBaseUrl: string) {
  return {
    denApiBase: registryBaseUrl,
    token: E2E_SKILL_REGISTRY_TOKEN,
    orgId: E2E_SKILL_REGISTRY_ORG_ID,
    user: { id: E2E_SKILL_REGISTRY_USER_ID },
    org: { id: E2E_SKILL_REGISTRY_ORG_ID },
  };
}

function clientFor(profile: StandaloneVesloServerProfile, token: string): MinimalVesloServerClient {
  return {
    baseUrl: profile.baseUrl,
    token,
    syncWorkspaceSkillMaterialization: async () => ({ synced: false, reloadRequired: false }),
    syncGlobalSkillMaterialization: async () => ({ synced: false, reloadRequired: false }),
  };
}

async function pollRegistryEvents(profile: StandaloneVesloServerProfile, token: string): Promise<Response> {
  const url = new URL('/v1/skill-registry-events', profile.baseUrl);
  url.searchParams.set('limit', '1');
  url.searchParams.set('orgId', E2E_SKILL_REGISTRY_ORG_ID);
  url.searchParams.set('workspaceId', profile.workspaceId);
  return fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-veslo-den-org-id': E2E_SKILL_REGISTRY_ORG_ID,
    },
  });
}

test('skill registry event auth desync does not restart polling against the same stale server token', async () => {
  const { createRoot } = await loadAppSolidRoot();
  const { createSkillRegistryOrchestrator } = await loadAppOrchestrator();
  const registryBaseUrl = await startSkillRegistryFixture();
  const profileRoot = await mkdtemp(join(tmpdir(), 'veslo-e2e-skill-registry-auth-'));
  let profile: StandaloneVesloServerProfile | null = null;

  try {
    profile = await startStandaloneVesloServerProfile({
      profileRoot,
      registryBaseUrl,
      profileName: 'skill-registry-auth-loop',
    });

    const staleToken = `${profile.clientToken}-stale`;
    const staleResponse = await pollRegistryEvents(profile, staleToken);
    assert.equal(staleResponse.status, 401);

    const liveResponse = await pollRegistryEvents(profile, profile.clientToken);
    assert.equal(liveResponse.status, 200);
    assert.deepEqual(await liveResponse.json(), {
      events: [],
      nextCursor: null,
    });

    await createRoot(async (dispose) => {
      try {
        const listener = createListenerCapture();
        const errors: Array<{ scope: string; status: number | null }> = [];
        const ensures: unknown[] = [];
        const staleClient = clientFor(profile!, staleToken);

        createSkillRegistryOrchestrator({
          vesloServerClient: () => staleClient,
          vesloServerStatus: () => 'connected',
          activeWorkspaceId: () => profile!.workspaceId,
          workspaceBusy: () => ({}),
          denAuthRevision: () => 1,
          readDenAuth: () => denAuth(registryBaseUrl),
          refreshSkills: async () => undefined,
          invalidateSkillRegistryInventory: async () => undefined,
          markReloadRequired: () => undefined,
          reportError: (error: unknown, scope: unknown) => {
            const status = typeof (error as { status?: unknown }).status === 'number'
              ? (error as { status: number }).status
              : null;
            errors.push({
              scope: String(scope),
              status,
            });
          },
          ensureLocalVesloServerRunning: async (options: unknown) => {
            ensures.push(options);
            const reacquiredResponse = await pollRegistryEvents(profile!, profile!.clientToken);
            assert.equal(reacquiredResponse.status, 200);
            return true;
          },
          createListener: listener.createListener,
        });

        await flushEffects();
        assert.equal(listener.started, 1);

        await listener.options.onUnauthorized?.({
          name: 'SkillRegistryEventsAuthError',
          message: `HTTP ${staleResponse.status}`,
          status: staleResponse.status,
        });

        assert.equal(listener.stopped, 1);
        assert.deepEqual(errors, [{ scope: 'skills.registry.events.auth', status: 401 }]);
        assert.deepEqual(ensures, [{ requireRuntimeChainReady: false }]);
        assert.equal(listener.started, 1);
      } finally {
        dispose();
      }
    });
  } finally {
    await profile?.stop();
    await stopSkillRegistryFixture();
    await rm(profileRoot, { recursive: true, force: true });
  }
});
