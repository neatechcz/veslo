import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  classifyCurrentRuntimeEvidence,
  runningEngineFromCurrentRuntimeEvidence,
} from '../current-runtime-evidence.js';
import { stopDirectChild, type DirectChildStopResult } from '../direct-child-stop.js';
import {
  createEngineGenerationAuthority,
  type ProcessInstanceObservation,
} from '../engine-generation-authority.js';
import { EnginePool, type EngineProcess, type ScheduleApi } from '../engine-pool.js';
import { createRunActivityProbe } from '../run-activity-probe.js';
import { createRunRegistry, RunAlreadyActiveError } from '../run-registry.js';
import { createRunStore, type RunEngineOwner } from '../run-store.js';
import { resolveTerminalRuntimeHandoffEvidence } from '../terminal-runtime-handoff-recovery.js';

const workspace = { id: 'ws-a', path: 'C:/repo' };
const conversationId = 'conv-a';

const inertSchedule: ScheduleApi = {
  setInterval: () => Symbol('interval'),
  clearInterval: () => {},
  setTimeout: () => Symbol('timeout'),
  clearTimeout: () => {},
};

function ownerFromEngine(engine: EngineProcess): RunEngineOwner & { workspaceId: string } {
  return {
    workspaceId: engine.workspaceId,
    engineSlotId: engine.workspaceId,
    engineOwnerId: engine.engineOwnerId,
    enginePid: engine.pid,
    engineStartedAt: engine.spawnedAt,
    engineBaseUrl: engine.baseUrl,
  };
}

type HarnessOptions = {
  childKind?: 'direct' | 'wsl';
  stopOutcome?: DirectChildStopResult['outcome'];
};

async function createHarness(options: HarnessOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'veslo-terminal-handoff-chain-'));
  const dbPath = join(directory, 'runs.sqlite');
  const observations = new Map<number, ProcessInstanceObservation>();
  const inspections: ProcessInstanceObservation[] = [];
  const children: ChildProcess[] = [];
  let nextPid = 41_000;
  let nextPort = 51_000;
  let clock = 10_000;
  let requestBuilds = 0;

  const now = () => {
    clock += 10;
    return clock;
  };
  const inspector = {
    inspect: async (pid: number): Promise<ProcessInstanceObservation> => {
      const observation = observations.get(pid) ?? { kind: 'absent' as const };
      inspections.push(observation);
      return observation;
    },
  };
  const generationAuthority = createEngineGenerationAuthority({
    dbPath,
    orchestratorInstanceId: 'orchestrator-chain-test',
    orchestratorStartedAt: 9_000,
    inspector,
    now,
  });

  const markChildExited = (child: ChildProcess, emit: boolean) => {
    const pid = child.pid!;
    observations.set(pid, { kind: 'absent' });
    (child as ChildProcess & { exitCode: number | null }).exitCode = 0;
    if (emit) child.emit('exit', 0, null);
  };
  const spawnChild = (): ChildProcess => {
    const pid = nextPid++;
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperties(child, {
      pid: { value: pid },
      exitCode: { value: null, writable: true },
      signalCode: { value: null, writable: true },
    });
    observations.set(pid, {
      kind: 'alive',
      identity: { pid, birthToken: `birth-${pid}` },
    });
    child.kill = () => {
      markChildExited(child, true);
      return true;
    };
    children.push(child);
    return child;
  };

  const pool = new EnginePool({
    deps: {
      resolveWorkspace: async () => ({ workdir: workspace.path, configDir: 'C:/config/ws-a' }),
      spawnEngine: async ({ port }) => ({
        child: spawnChild(),
        childKind: options.childKind ?? 'direct',
        baseUrl: `http://127.0.0.1:${port}`,
      }),
      waitForHealthy: async () => {},
      stopChild: async (child) => {
        if (!options.stopOutcome) return stopDirectChild(child);
        if (options.stopOutcome === 'exit_observed') markChildExited(child, false);
        return { outcome: options.stopOutcome };
      },
      findFreePort: async () => nextPort++,
      isProcessAlive: (pid) => observations.get(pid)?.kind === 'alive',
      now,
      schedule: inertSchedule,
      sleep: async () => {},
      generationLifecycle: {
        beforeSpawn: (seed) => {
          generationAuthority.registerCreating(seed);
        },
        afterSpawn: async (engine) => {
          await generationAuthority.activate({
            workspaceId: engine.workspaceId,
            engineSlotId: engine.workspaceId,
            engineOwnerId: engine.engineOwnerId,
            enginePid: engine.pid,
            engineStartedAt: engine.spawnedAt,
            engineBaseUrl: engine.baseUrl,
          });
        },
        beforeStop: (engine, reason) => {
          generationAuthority.beginStop(ownerFromEngine(engine), reason);
        },
        afterExit: (engine, reason) => {
          generationAuthority.confirmExit(ownerFromEngine(engine), reason);
        },
      },
    },
    config: {
      idleSweepIntervalMs: 1_000_000,
      healthIntervalMs: 1_000_000,
    },
  });

  let runtimeSnapshot = () => pool.get(workspace.id);
  const probeRunActivity = createRunActivityProbe({
    getEngine: () => runningEngineFromCurrentRuntimeEvidence(classifyCurrentRuntimeEvidence({
      snapshot: runtimeSnapshot(),
    })),
    getEngineOwnerId: (engine) => engine.engineOwnerId,
    buildEngineRequest: () => {
      requestBuilds += 1;
      return { url: 'http://127.0.0.1/forbidden', headers: {} };
    },
    fetchImpl: (async () => { throw new Error('network forbidden'); }) as unknown as typeof fetch,
  });
  const registry = createRunRegistry({
    store: createRunStore({ dbPath }),
    probeRunActivity,
    now,
  });

  const attachTerminalRun = async (engine: EngineProcess) => {
    const owner = ownerFromEngine(engine);
    await registry.register({
      workspaceId: workspace.id,
      conversationId,
      runId: 'run-old',
      engineSessionId: 'session-old',
      directory: workspace.path,
      kind: 'prompt',
    });
    expect(registry.attachEngineOwner(workspace.id, 'run-old', owner)).toMatchObject({
      engineOwnerState: 'attached',
    });
    expect(registry.markFailed(workspace.id, 'run-old', 'terminal provider failure')).toMatchObject({
      status: 'failed',
      engineOwnerState: 'attached',
    });
    return owner;
  };

  const admitSuccessorAndReachOpenCode = async () => {
    const admitted = await registry.register({
      workspaceId: workspace.id,
      conversationId,
      runId: 'run-successor',
      engineSessionId: 'session-successor',
      directory: workspace.path,
      kind: 'prompt',
    });
    const engine = await pool.ensure(workspace);
    return { admitted, engine };
  };

  return {
    pool,
    registry,
    generationAuthority,
    inspections,
    observations,
    children,
    attachTerminalRun,
    admitSuccessorAndReachOpenCode,
    requestBuilds: () => requestBuilds,
    useNoCurrentRuntime: () => {
      runtimeSnapshot = () => undefined;
    },
    cleanup: async () => {
      await pool.killAll();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('terminal runtime handoff recovery chain', () => {
  test('observed direct exit preserves the stopped snapshot and admits exactly one successor after exact recovery', async () => {
    const h = await createHarness();
    try {
      const oldEngine = await h.pool.ensure(workspace);
      const oldOwner = await h.attachTerminalRun(oldEngine);
      const initialSpawnCount = h.children.length;

      const stop = await h.pool.suspend(workspace.id, 'pool-idle-suspend');
      expect(stop).toMatchObject({
        outcome: 'exit_observed',
        childKind: 'direct',
        engineOwnerId: oldOwner.engineOwnerId,
      });
      const retainedSnapshot = h.pool.get(workspace.id);
      expect(retainedSnapshot).toBe(oldEngine);
      expect(retainedSnapshot?.state).toBe('suspended');
      const currentRuntime = classifyCurrentRuntimeEvidence({ snapshot: retainedSnapshot });
      expect(currentRuntime.kind).toBe('stopped_snapshot');

      const latest = await h.registry.latest(workspace.id, conversationId);
      expect(latest).toMatchObject({
        stale: true,
        runtimeReadyForSuccessor: null,
        unavailableReason: 'no_current_engine',
      });
      expect(h.requestBuilds()).toBe(0);

      const recoveryInputs: unknown[] = [];
      const recovery = await resolveTerminalRuntimeHandoffEvidence({
        owner: oldOwner,
        currentRuntimeEvidence: currentRuntime.kind,
        generationAuthority: {
          resolveOwnerEvidence: (input) => {
            recoveryInputs.push(input);
            return h.generationAuthority.resolveOwnerEvidence(input);
          },
        },
      });
      expect(recovery).toEqual(expect.objectContaining({ kind: 'lost_proven' }));
      expect(recoveryInputs).toEqual([{
        owner: oldOwner,
        currentRuntimeEvidence: 'stopped_snapshot',
      }]);

      const markedLost = h.registry.markTerminalRunEngineLost({
        ...oldOwner,
        runId: 'run-old',
      });
      expect(markedLost).toMatchObject({
        workspaceId: oldOwner.workspaceId,
        runId: 'run-old',
        status: 'failed',
        engineOwnerState: 'lost',
        engineSlotId: oldOwner.engineSlotId,
        engineOwnerId: oldOwner.engineOwnerId,
        enginePid: oldOwner.enginePid,
        engineStartedAt: oldOwner.engineStartedAt,
        engineBaseUrl: oldOwner.engineBaseUrl,
      });

      const fresh = await h.registry.latest(workspace.id, conversationId);
      expect(fresh).toMatchObject({
        stale: false,
        runtimeReadyForSuccessor: true,
        record: {
          engineOwnerState: 'lost',
          engineSlotId: oldOwner.engineSlotId,
          engineOwnerId: oldOwner.engineOwnerId,
          enginePid: oldOwner.enginePid,
          engineStartedAt: oldOwner.engineStartedAt,
          engineBaseUrl: oldOwner.engineBaseUrl,
        },
      });
      expect(h.requestBuilds()).toBe(0);

      const successor = await h.admitSuccessorAndReachOpenCode();
      expect(successor.admitted).toMatchObject({ runId: 'run-successor', status: 'running' });
      expect(successor.engine.engineOwnerId).not.toBe(oldOwner.engineOwnerId);
      expect(h.children.length - initialSpawnCount).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test('unconfirmed direct stop stays unsafe and exact alive or unknown inspection admits no successor', async () => {
    for (const observation of [
      { kind: 'alive', identity: { pid: 0, birthToken: 'placeholder' } } as const,
      { kind: 'unknown', reason: 'inspection_failed' } as const,
    ]) {
      const h = await createHarness({ childKind: 'direct', stopOutcome: 'exit_unconfirmed' });
      try {
        const oldEngine = await h.pool.ensure(workspace);
        const oldOwner = await h.attachTerminalRun(oldEngine);
        const initialSpawnCount = h.children.length;
        const exactObservation = observation.kind === 'alive'
          ? {
              kind: 'alive' as const,
              identity: {
                pid: oldEngine.pid,
                birthToken: `birth-${oldEngine.pid}`,
              },
            }
          : observation;
        h.observations.set(oldEngine.pid, exactObservation);

        const stop = await h.pool.suspend(workspace.id, 'pool-idle-suspend');
        expect(stop).toMatchObject({
          outcome: 'exit_unconfirmed',
          childKind: 'direct',
          engineOwnerId: oldOwner.engineOwnerId,
        });
        expect(h.pool.get(workspace.id)).toBe(oldEngine);
        expect(oldEngine.state).not.toBe('suspended');
        expect(classifyCurrentRuntimeEvidence({ snapshot: h.pool.get(workspace.id) }).kind).not.toBe(
          'stopped_snapshot',
        );
        expect(h.pool.getRunning(workspace.id)).toBeNull();

        // A later process with no in-memory entry must still resolve the exact
        // durable generation. Alive and unknown observations both stay closed.
        h.useNoCurrentRuntime();
        const latest = await h.registry.latest(workspace.id, conversationId);
        expect(latest).toMatchObject({
          stale: true,
          runtimeReadyForSuccessor: null,
          unavailableReason: 'no_current_engine',
        });
        expect(h.requestBuilds()).toBe(0);

        const currentRuntime = classifyCurrentRuntimeEvidence({ snapshot: null });
        const recovery = await resolveTerminalRuntimeHandoffEvidence({
          owner: oldOwner,
          currentRuntimeEvidence: currentRuntime.kind,
          generationAuthority: h.generationAuthority,
        });
        expect(h.inspections.at(-1)).toEqual(exactObservation);
        expect(recovery).toEqual(observation.kind === 'alive'
          ? { kind: 'live_or_ambiguous', reason: 'exact_process_alive' }
          : { kind: 'unknown', reason: 'process_identity_unavailable' });

        const fresh = await h.registry.latest(workspace.id, conversationId);
        expect(fresh?.runtimeReadyForSuccessor).toBeNull();
        await expect(h.admitSuccessorAndReachOpenCode()).rejects.toBeInstanceOf(RunAlreadyActiveError);
        expect(h.requestBuilds()).toBe(0);
        expect(h.children.length - initialSpawnCount).toBe(0);
      } finally {
        await h.cleanup();
      }
    }
  });

  test('stopped WSL snapshots stay unsupported for either wrapper-exit outcome while ready and idle remain usable', async () => {
    for (const stopOutcome of ['exit_observed', 'exit_unconfirmed'] as const) {
      const h = await createHarness({ childKind: 'wsl', stopOutcome });
      try {
        const oldEngine = await h.pool.ensure(workspace);
        const oldOwner = await h.attachTerminalRun(oldEngine);
        const initialSpawnCount = h.children.length;

        const readyEvidence = classifyCurrentRuntimeEvidence({ snapshot: oldEngine });
        expect(readyEvidence.kind).toBe('running');
        expect(runningEngineFromCurrentRuntimeEvidence(readyEvidence)).toBe(oldEngine);
        oldEngine.state = 'idle';
        const idleEvidence = classifyCurrentRuntimeEvidence({ snapshot: oldEngine });
        expect(idleEvidence.kind).toBe('running');
        expect(runningEngineFromCurrentRuntimeEvidence(idleEvidence)).toBe(oldEngine);

        const stop = await h.pool.suspend(workspace.id, 'pool-idle-suspend');
        expect(stop).toMatchObject({ outcome: stopOutcome, childKind: 'wsl' });
        const retainedSnapshot = h.pool.get(workspace.id);
        expect(retainedSnapshot).toBe(oldEngine);
        expect(retainedSnapshot?.state).toBe('suspended');
        const currentRuntime = classifyCurrentRuntimeEvidence({ snapshot: retainedSnapshot });
        expect(currentRuntime.kind).toBe('unsupported_wrapper_snapshot');
        expect(runningEngineFromCurrentRuntimeEvidence(currentRuntime)).toBeNull();

        const latest = await h.registry.latest(workspace.id, conversationId);
        expect(latest).toMatchObject({
          stale: true,
          runtimeReadyForSuccessor: null,
          unavailableReason: 'no_current_engine',
        });
        expect(h.requestBuilds()).toBe(0);

        const inspectionsBeforeRecovery = h.inspections.length;
        await expect(resolveTerminalRuntimeHandoffEvidence({
          owner: oldOwner,
          currentRuntimeEvidence: currentRuntime.kind,
          generationAuthority: h.generationAuthority,
        })).resolves.toEqual({
          kind: 'live_or_ambiguous',
          reason: 'unsupported_wrapper_snapshot',
        });
        expect(h.inspections.length).toBe(inspectionsBeforeRecovery);

        const fresh = await h.registry.latest(workspace.id, conversationId);
        expect(fresh?.runtimeReadyForSuccessor).toBeNull();
        await expect(h.admitSuccessorAndReachOpenCode()).rejects.toBeInstanceOf(RunAlreadyActiveError);
        expect(h.requestBuilds()).toBe(0);
        expect(h.children.length - initialSpawnCount).toBe(0);
      } finally {
        await h.cleanup();
      }
    }
  });
});
