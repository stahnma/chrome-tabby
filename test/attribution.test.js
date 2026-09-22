// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { archiveEntry } from '../src/core/archive.js';

const decision = {
  tabId: 1, windowId: 2, evidenceHash: 'h', title: 'T', url: 'https://x.test/a',
  ageHours: 50, facets: {}, action: 'close', reasons: [],
};

test('an automatic close is recorded as auto', () => {
  assert.equal(archiveEntry(decision, {}, 'run-1', {}, 'auto').by, 'auto');
});

test('a manual close is recorded as manual', () => {
  assert.equal(archiveEntry(decision, {}, 'run-1', {}, 'manual').by, 'manual');
});

/**
 * The display bug: entries written before attribution existed have no `by`, and rendering
 * them as 'auto' told the user the nightly run closed tabs they had closed themselves.
 * A missing field means unknown, and must render as unknown.
 */
function describe(entry) {
  return entry.by === 'manual' ? 'closed by you'
    : entry.by === 'auto' ? 'closed by a run'
    : 'closed before this was recorded';
}

test('a legacy entry with no attribution is not claimed by either side', () => {
  const legacy = { id: 'arc_old', closedAt: 1, title: 'T', url: 'https://x.test/a', runId: 'run-0' };
  assert.equal(describe(legacy), 'closed before this was recorded');
});

test('a legacy entry is not inferred from its runId', () => {
  // runId 'manual' looks like a hint but is not one: a hand-close during a staged
  // proposal inherits that proposal's runId, so the signal is not trustworthy.
  const legacy = { id: 'arc_old', closedAt: 1, title: 'T', url: 'https://x.test/a', runId: 'manual' };
  assert.equal(describe(legacy), 'closed before this was recorded');
});

test('new entries render definitively', () => {
  assert.equal(describe(archiveEntry(decision, {}, 'r', {}, 'manual')), 'closed by you');
  assert.equal(describe(archiveEntry(decision, {}, 'r', {}, 'auto')), 'closed by a run');
});
