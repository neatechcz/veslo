import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_PILOT_RUN_STALE_AFTER_MS,
  PILOT_RUN_MANIFEST_FILE,
  createPilotRunContext,
  prunePilotRunHistory,
  readPilotRunManifest,
  reconcileAbandonedPilotRuns,
} from './pilot-run-store.js';

function withTemporaryRoot(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'veslo-pilot-run-store-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Pilot run store creates an isolated run manifest, stream roots, and lifecycle timeline', () => {
  withTemporaryRoot((root) => {
    let now = new Date('2026-07-16T18:00:00.000Z');
    const context = createPilotRunContext({
      rootDir: root,
      runId: 'pilot-unit-run',
      suite: 'live-inference',
      scenarios: ['message-send-registry-degraded'],
      binary: 'tauri-pilot.exe',
      profileMode: 'isolated',
      authMode: 'live-den',
      fixtures: ['none'],
      hostname: 'unit-host',
      pid: 4312,
      now: () => now,
    });

    assert.equal(existsSync(join(context.runDir, PILOT_RUN_MANIFEST_FILE)), true);
    assert.equal(existsSync(context.traceDir), true);
    assert.equal(existsSync(context.appLogDir), true);
    assert.equal(existsSync(context.scenarioDir('../message send.toml')), true);

    const created = readPilotRunManifest(context.runDir);
    assert.deepEqual(created?.metadata, {
      suite: 'live-inference',
      scenarios: ['message-send-registry-degraded'],
      binary: 'tauri-pilot.exe',
      profileMode: 'isolated',
      authMode: 'live-den',
      fixtures: ['none'],
    });
    assert.equal(created?.status, 'running');
    assert.equal(created?.owner.heartbeatAt, '2026-07-16T18:00:00.000Z');

    now = new Date('2026-07-16T18:00:05.000Z');
    context.heartbeat();
    now = new Date('2026-07-16T18:00:06.000Z');
    context.finish('passed');

    const finished = readPilotRunManifest(context.runDir);
    assert.equal(finished?.status, 'passed');
    assert.equal(finished?.owner.heartbeatAt, '2026-07-16T18:00:05.000Z');
    assert.equal(finished?.finishedAt, '2026-07-16T18:00:06.000Z');
    const timeline = readFileSync(join(context.runDir, 'runner.ndjson'), 'utf8');
    assert.match(timeline, /"event":"run\.started"/);
    assert.match(timeline, /"event":"run\.finished"/);
  });
});

test('stale run reconciliation abandons only a provably dead local owner', () => {
  withTemporaryRoot((root) => {
    const startedAt = new Date('2026-07-16T18:00:00.000Z');
    const createRunning = (runId: string, pid: number, hostname = 'unit-host') => createPilotRunContext({
      rootDir: root,
      runId,
      scenarios: [runId],
      hostname,
      pid,
      now: () => startedAt,
    });
    const dead = createRunning('dead-owner', 1101);
    const alive = createRunning('alive-owner', 1102);
    const remote = createRunning('remote-owner', 1103, 'another-host');
    const active = createRunning('active-owner', 1104);
    const invalidDir = join(root, 'invalid-manifest');
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(join(invalidDir, 'placeholder'), 'not a manifest', 'utf8');

    const warnings: string[] = [];
    const result = reconcileAbandonedPilotRuns({
      rootDir: root,
      activeRunId: active.runId,
      now: new Date(startedAt.getTime() + DEFAULT_PILOT_RUN_STALE_AFTER_MS + 1),
      hostname: 'unit-host',
      isOwnerProcessAlive: (pid) => pid === alive.manifest().owner.pid,
      warn: (message) => warnings.push(message),
    });

    assert.deepEqual(result.abandonedRunIds, [dead.runId]);
    assert.deepEqual(new Set(result.retainedRunningRunIds), new Set([
      alive.runId,
      remote.runId,
      active.runId,
    ]));
    assert.deepEqual(result.skippedInvalidDirectories, ['invalid-manifest']);
    assert.equal(readPilotRunManifest(dead.runDir)?.status, 'abandoned');
    assert.equal(readPilotRunManifest(dead.runDir)?.abandonmentReason, 'owner-process-not-alive');
    assert.equal(readPilotRunManifest(alive.runDir)?.status, 'running');
    assert.equal(readPilotRunManifest(remote.runDir)?.status, 'running');
    assert.equal(readPilotRunManifest(active.runDir)?.status, 'running');
    assert.equal(existsSync(invalidDir), true);
    assert.match(warnings.join('\n'), /another host/);
    assert.match(warnings.join('\n'), /owner PID is still alive/);
  });
});

test('retention keeps the newest terminal runs, reconciles dead owners, and never removes active or invalid directories', () => {
  withTemporaryRoot((root) => {
    const base = Date.parse('2026-07-16T18:00:00.000Z');
    const terminalRuns = Array.from({ length: 12 }, (_, index) => {
      let now = new Date(base + index * 1_000);
      const context = createPilotRunContext({
        rootDir: root,
        runId: `terminal-${String(index).padStart(2, '0')}`,
        scenarios: [`scenario-${index}`],
        hostname: 'unit-host',
        pid: 2000 + index,
        now: () => now,
      });
      now = new Date(base + index * 1_000 + 100);
      context.finish('passed');
      return context;
    });
    const stale = createPilotRunContext({
      rootDir: root,
      runId: 'stale-dead-owner',
      scenarios: ['stale'],
      hostname: 'unit-host',
      pid: 4111,
      now: () => new Date(base - DEFAULT_PILOT_RUN_STALE_AFTER_MS - 10_000),
    });
    const active = createPilotRunContext({
      rootDir: root,
      runId: 'active-current-run',
      scenarios: ['active'],
      hostname: 'unit-host',
      pid: 4222,
      now: () => new Date(base - DEFAULT_PILOT_RUN_STALE_AFTER_MS - 10_000),
    });
    const invalidDir = join(root, 'invalid-manifest');
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(join(invalidDir, 'placeholder'), 'not a manifest', 'utf8');

    const result = prunePilotRunHistory({
      rootDir: root,
      keepTerminal: 10,
      activeRunId: active.runId,
      now: new Date(base + 60_000),
      hostname: 'unit-host',
      isOwnerProcessAlive: (pid) => pid === active.manifest().owner.pid,
      warn: () => {},
    });

    assert.deepEqual(result.reconciliation.abandonedRunIds, [stale.runId]);
    assert.deepEqual(result.removedRunIds, ['stale-dead-owner', 'terminal-00', 'terminal-01']);
    assert.deepEqual(result.retainedRunIds, terminalRuns.slice(2).map((run) => run.runId).reverse());
    assert.equal(existsSync(stale.runDir), false);
    assert.equal(existsSync(terminalRuns[0].runDir), false);
    assert.equal(existsSync(terminalRuns[1].runDir), false);
    assert.equal(existsSync(terminalRuns[2].runDir), true);
    assert.equal(existsSync(terminalRuns[11].runDir), true);
    assert.equal(readPilotRunManifest(active.runDir)?.status, 'running');
    assert.equal(existsSync(invalidDir), true);
  });
});
