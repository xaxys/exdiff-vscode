'use strict';

/**
 * Headless tests for the snapshot-retention helpers in `out/core/snapshot.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { isAdHocSlot, selectStaleSnapshots } = require('../out/core/snapshot.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 0, 31);

test('selectStaleSnapshots prunes entries older than the retention window', () => {
  const entries = [
    { slot: 'base', syncedAt: NOW - 10 * DAY },
    { slot: 'head', syncedAt: NOW - 3 * DAY },
    { slot: 'ref-main', syncedAt: NOW - 1 * DAY },
  ];

  assert.deepEqual(selectStaleSnapshots(entries, 7, NOW), ['base']);
  assert.deepEqual(selectStaleSnapshots(entries, 7, NOW, true), []);
  assert.deepEqual(selectStaleSnapshots(entries, 2, NOW), ['base', 'head']);
});

test('selectStaleSnapshots only returns ad-hoc slots when asked', () => {
  const entries = [
    { slot: 'base', syncedAt: NOW - 30 * DAY },
    { slot: 'prev', syncedAt: NOW - 30 * DAY },
    { slot: 'ref-feature-x-abc1234', syncedAt: NOW - 30 * DAY },
    { slot: 'ref-feature-y-def5678', syncedAt: NOW - 1 * DAY },
  ];

  assert.deepEqual(selectStaleSnapshots(entries, 7, NOW, true), ['ref-feature-x-abc1234']);
});

test('selectStaleSnapshots disables pruning for 0/negative retention', () => {
  const entries = [{ slot: 'base', syncedAt: 1 }];

  assert.deepEqual(selectStaleSnapshots(entries, 0, NOW), []);
  assert.deepEqual(selectStaleSnapshots(entries, -1, NOW), []);
  assert.deepEqual(selectStaleSnapshots(entries, Number.NaN, NOW), []);
});

test('selectStaleSnapshots ignores entries without a usable timestamp', () => {
  const entries = [
    { slot: 'base', syncedAt: 0 },
    { slot: 'head', syncedAt: Number.NaN },
    { slot: 'ref-old', syncedAt: NOW - 8 * DAY },
  ];

  assert.deepEqual(selectStaleSnapshots(entries, 7, NOW), ['ref-old']);
});

test('isAdHocSlot only matches compare-ref slots', () => {
  assert.equal(isAdHocSlot('ref-main-abc1234'), true);
  assert.equal(isAdHocSlot('base'), false);
  assert.equal(isAdHocSlot('ref'), false);
});
