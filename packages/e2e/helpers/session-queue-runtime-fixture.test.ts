import assert from 'node:assert/strict';
import test from 'node:test';

import { startSessionQueueRuntimeFixture } from './session-queue-runtime-fixture.js';

test('session queue runtime fixture holds, releases, and deterministically fails queued OpenCode submissions', async () => {
  const fixture = await startSessionQueueRuntimeFixture();
  try {
    const session = await fetch(`${fixture.baseUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'ses-fixture', directory: '/fixture/workspace' }),
    });
    assert.equal(session.status, 200);

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
