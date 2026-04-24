import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveMochaTimeout } from '../wdio.conf.js';

test('resolveMochaTimeout uses positive E2E_MOCHA_TIMEOUT overrides', () => {
  assert.equal(resolveMochaTimeout({ E2E_MOCHA_TIMEOUT: '720000' }), 720000);
});

test('resolveMochaTimeout falls back to the default for invalid overrides', () => {
  assert.equal(resolveMochaTimeout({ E2E_MOCHA_TIMEOUT: '0' }), 180000);
  assert.equal(resolveMochaTimeout({ E2E_MOCHA_TIMEOUT: 'not-a-number' }), 180000);
  assert.equal(resolveMochaTimeout({}), 180000);
});
