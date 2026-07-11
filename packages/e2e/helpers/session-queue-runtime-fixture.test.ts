import assert from 'node:assert/strict';
import test from 'node:test';

import { startSessionQueueRuntimeFixture } from './session-queue-runtime-fixture.js';

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
