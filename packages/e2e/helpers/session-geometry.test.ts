import test from 'node:test';
import assert from 'node:assert/strict';

import { hasIntentionalHorizontalScroller, sessionGeometryFailures, type SessionGeometryRect } from './session-geometry.js';

const rect = (left: number, top: number, width: number, height: number): SessionGeometryRect => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});

test('session geometry accepts contained rows and a visible composer', () => {
  assert.deepEqual(sessionGeometryFailures({
    viewport: { width: 768, height: 900 },
    root: rect(0, 0, 768, 900),
    center: rect(0, 48, 768, 852),
    composer: rect(24, 770, 720, 100),
    messageRows: [rect(120, 100, 500, 90)],
  }), []);
});

test('session geometry reports overflow, escaped rows, and composer overlap', () => {
  assert.deepEqual(sessionGeometryFailures({
    viewport: { width: 390, height: 844 },
    root: rect(0, 0, 405, 844),
    center: rect(0, 48, 390, 796),
    composer: rect(12, 720, 366, 100),
    messageRows: [rect(-1, 90, 400, 40)],
    overlays: [rect(0, 700, 390, 100)],
  }), [
    'root overflows the viewport horizontally',
    'message row escapes the center pane',
    'overlay covers the composer',
  ]);
});

test('long content must fit or use an intentional horizontal scroller', () => {
  assert.equal(hasIntentionalHorizontalScroller({ content: { scrollWidth: 410, clientWidth: 400 } }), false);
  assert.equal(hasIntentionalHorizontalScroller({
    content: { scrollWidth: 410, clientWidth: 400 },
    nearestHorizontalScroller: { overflowX: 'auto' },
  }), true);
  assert.equal(hasIntentionalHorizontalScroller({ content: { scrollWidth: 401, clientWidth: 400 } }), true);
});
