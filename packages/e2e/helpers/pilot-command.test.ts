import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPilotCommand,
  executePilotCommand,
  pilotCommandSucceeded,
} from './pilot-command.js';

test('Pilot command executor captures a successful process result', async () => {
  const result = await executePilotCommand({
    command: process.execPath,
    args: ['-e', 'console.log("pilot stdout"); console.error("pilot stderr");'],
  });

  assert.equal(pilotCommandSucceeded(result), true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
  assert.match(result.stdout, /pilot stdout/);
  assert.match(result.stderr, /pilot stderr/);
  assert.ok(result.durationMs >= 0);
  assert.ok(Number.isFinite(Date.parse(result.startedAt)));
  assert.ok(Number.isFinite(Date.parse(result.finishedAt)));
});

test('Pilot command executor reports a timeout without throwing away captured state', async () => {
  const result = await executePilotCommand({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => process.exit(0), 10_000);'],
    timeoutMs: 25,
  });

  assert.equal(pilotCommandSucceeded(result), false);
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 5_000);
});

test('Pilot command construction keeps the deterministic socket before subcommands', () => {
  assert.deepEqual(
    buildPilotCommand({
      binary: 'tauri-pilot',
      socket: '/tmp/pilot.sock',
      args: ['run', 'scenario.toml'],
    }),
    {
      command: 'tauri-pilot',
      args: ['--socket', '/tmp/pilot.sock', 'run', 'scenario.toml'],
    },
  );
});
