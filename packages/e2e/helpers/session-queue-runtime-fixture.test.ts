import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  materializeSessionQueueFixtureTranscript,
  startSessionQueueRuntimeFixture,
} from './session-queue-runtime-fixture.js';

test('session queue runtime fixture holds, releases, and deterministically fails queued OpenCode submissions', async () => {
  const fixture = await startSessionQueueRuntimeFixture();
  try {
    const health = await fetch(`${fixture.baseUrl}/global/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { healthy: true });

    const session = await fetch(`${fixture.baseUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ses-fixture', directory: '/fixture/workspace' }),
    });
    assert.equal(session.status, 200);

    const assistantEvent = await fetch(`${fixture.baseUrl}/__session_queue_fixture/emit-assistant-text-part`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'ses-fixture',
        messageId: 'msg-assistant-fixture',
        partId: 'part-assistant-fixture',
        text: 'Fixture assistant text',
      }),
    });
    assert.equal(assistantEvent.status, 200);
    assert.deepEqual(await assistantEvent.json(), {
      info: { id: 'msg-assistant-fixture', sessionID: 'ses-fixture', role: 'assistant' },
      part: {
        id: 'part-assistant-fixture',
        messageID: 'msg-assistant-fixture',
        sessionID: 'ses-fixture',
        type: 'text',
        text: 'Fixture assistant text',
      },
      emittedEventCount: 2,
    });

    const mirroredTranscript = await fetch(`${fixture.baseUrl}/__session_queue_fixture/append-session-transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'ses-fixture',
        messages: [{ id: 'msg-fixture', sessionID: 'ses-fixture', role: 'user' }],
        partsByMessageId: {
          'msg-fixture': [{ id: 'part-fixture', messageID: 'msg-fixture', type: 'file', filename: 'fixture.txt' }],
        },
      }),
    });
    assert.equal(mirroredTranscript.status, 200);
    assert.deepEqual(
      await fetch(`${fixture.baseUrl}/session/ses-fixture/message`).then((response) => response.json()),
      [{
        info: { id: 'msg-fixture', sessionID: 'ses-fixture', role: 'user' },
        parts: [{ id: 'part-fixture', messageID: 'msg-fixture', type: 'file', filename: 'fixture.txt' }],
      }],
    );
    assert.deepEqual(
      await fetch(`${fixture.baseUrl}/session/ses-fixture/message/msg-fixture/part`).then((response) => response.json()),
      [{ id: 'part-fixture', messageID: 'msg-fixture', type: 'file', filename: 'fixture.txt' }],
    );

    const registered = await fetch(`${fixture.baseUrl}/workspace/ws-fixture/runs/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-veslo-orchestrator-token': fixture.lifecycleToken,
      },
      body: JSON.stringify({
        conversationId: 'conv-fixture',
        runId: 'run-active',
        engineSessionId: 'ses-fixture',
        clientMessageId: 'message-active',
      }),
    });
    assert.equal(registered.status, 200);

    const activeBeforeRelease = await fetch(
      `${fixture.baseUrl}/workspace/ws-fixture/conversations/conv-fixture/runs/active`,
    );
    assert.equal(activeBeforeRelease.status, 200);

    await fetch(`${fixture.baseUrl}/__session_queue_fixture/release`, { method: 'POST' });
    const activeAfterRelease = await fetch(
      `${fixture.baseUrl}/workspace/ws-fixture/conversations/conv-fixture/runs/active`,
    );
    assert.equal(activeAfterRelease.status, 404);

    await fetch(`${fixture.baseUrl}/__session_queue_fixture/fail-next-prompt`, { method: 'POST' });
    const failedPrompt = await fetch(`${fixture.baseUrl}/session/ses-fixture/prompt_async`, { method: 'POST' });
    assert.equal(failedPrompt.status, 500);

    const state = await fetch(`${fixture.baseUrl}/__session_queue_fixture/state`).then((response) => response.json()) as {
      promptCalls?: number;
      failedPromptCalls?: number;
      runs?: Array<{ clientMessageId?: string | null; status?: string }>;
    };
    assert.equal(state.promptCalls, 1);
    assert.equal(state.failedPromptCalls, 1);
    assert.deepEqual(state.runs, [{
      workspaceId: 'ws-fixture',
      conversationId: 'conv-fixture',
      runId: 'run-active',
      engineSessionId: 'ses-fixture',
      clientMessageId: 'message-active',
      status: 'aborted',
    }]);
  } finally {
    await fixture.stop();
  }
});

test('session queue runtime fixture materializes canonical OpenCode rows for host transcript recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'veslo-session-queue-fixture-'));
  const workspacePath = join(root, 'workspace');
  try {
    materializeSessionQueueFixtureTranscript(
      workspacePath,
      {
        id: 'ses-sqlite',
        title: 'SQLite fixture session',
        directory: workspacePath,
        parentID: null,
        time: { created: 1_000, updated: 2_000 },
      },
      {
        messages: [{ id: 'msg-sqlite', sessionID: 'ses-sqlite', role: 'user' }],
        partsByMessageId: {
          'msg-sqlite': [{
            id: 'part-sqlite',
            messageID: 'msg-sqlite',
            sessionID: 'ses-sqlite',
            type: 'text',
            text: 'Canonical fixture text',
          }],
        },
      },
    );

    const database = new DatabaseSync(join(workspacePath, '.opencode', 'opencode.db'));
    try {
      assert.deepEqual(
        { ...database.prepare('SELECT id, title, directory FROM session WHERE id = ?').get('ses-sqlite') as object },
        { id: 'ses-sqlite', title: 'SQLite fixture session', directory: workspacePath },
      );
      assert.deepEqual(
        { ...database.prepare('SELECT id, session_id, data FROM message WHERE id = ?').get('msg-sqlite') as object },
        {
          id: 'msg-sqlite',
          session_id: 'ses-sqlite',
          data: JSON.stringify({ id: 'msg-sqlite', sessionID: 'ses-sqlite', role: 'user' }),
        },
      );
      assert.deepEqual(
        { ...database.prepare('SELECT id, message_id, session_id, data FROM part WHERE id = ?').get('part-sqlite') as object },
        {
          id: 'part-sqlite',
          message_id: 'msg-sqlite',
          session_id: 'ses-sqlite',
          data: JSON.stringify({
            id: 'part-sqlite',
            messageID: 'msg-sqlite',
            sessionID: 'ses-sqlite',
            type: 'text',
            text: 'Canonical fixture text',
          }),
        },
      );
    } finally {
      database.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
