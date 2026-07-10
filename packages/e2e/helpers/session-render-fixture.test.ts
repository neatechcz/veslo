import test from 'node:test';
import assert from 'node:assert/strict';

import { createSessionRenderArtifactManifest } from './session-render-fixture.js';

test('session render artifact manifest records only safe fixture metadata', () => {
  const manifest = createSessionRenderArtifactManifest({
    widths: [390, 768, 390, 1440],
    sessionId: 'ses-render-fixture',
    conversationId: 'conv-render-fixture',
    serverToken: 'super-secret-token',
    prompt: 'private fixture prompt body',
    attachmentPath: 'C:\\private\\fixture.txt',
    capturedAt: '2026-07-10T12:00:00.000Z',
  });

  assert.deepEqual(manifest, {
    scenario: 'session-render-stability',
    capturedAt: '2026-07-10T12:00:00.000Z',
    widths: [390, 768, 1440],
    hasServerToken: true,
    sessionId: 'ses-render-fixture',
    conversationId: 'conv-render-fixture',
  });
  assert.equal(JSON.stringify(manifest).includes('super-secret-token'), false);
  assert.equal(JSON.stringify(manifest).includes('private fixture prompt body'), false);
  assert.equal(JSON.stringify(manifest).includes('C:\\private\\fixture.txt'), false);
});
