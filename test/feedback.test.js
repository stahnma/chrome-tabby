// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { score, sweepThresholds, prune, previewChange, REASONS } from '../src/core/feedback.js';
import { defaultSettings } from '../src/core/schema.js';
import { evaluateGates } from '../src/core/decide.js';

const settings = (over = {}) => ({ ...defaultSettings(), ...over });

/** @returns {any} */
function label(over = {}) {
  return {
    id: 'l', at: 1, evidenceHash: 'h', url: 'https://x.test/a', host: 'x.test', title: 'T',
    verdict: 'close', reason: 'missed', ageHours: 500,
    facets: { wip: 0.1, disposable: 0.9, retrievable: 0.9, savedForLater: 0.1, dead: 0.05 },
    ...over,
  };
}

test('every reason maps to a verdict', () => {
  for (const [k, v] of Object.entries(REASONS)) {
    assert.ok(v.verdict === 'close' || v.verdict === 'keep', k);
    assert.ok(v.label && v.hint, k);
  }
});

test('score counts agreement against stored judgments', () => {
  const s = score([label()], settings());
  assert.equal(s.total, 1);
  assert.equal(s.agree, 1, 'a disposable, stale, non-wip tab should close');
});

test('closing something wanted costs more than keeping something stale', () => {
  // A false close destroys work; a false keep just leaves a tab open.
  const falseClose = score([label({ verdict: 'keep' })], settings());
  const falseKeep = score([label({ verdict: 'close', facets: { wip: 0.9, disposable: 0.1, retrievable: 0.1, savedForLater: 0.1, dead: 0 } })], settings());
  assert.equal(falseClose.falseClose, 1);
  assert.equal(falseKeep.falseKeep, 1);
  assert.ok(falseClose.cost > falseKeep.cost, 'a false close must be penalised harder');
});

test('the sweep declines to guess from too few labels', () => {
  const r = sweepThresholds([label()], settings());
  assert.equal(r.enoughData, false);
  assert.deepEqual(r.thresholds, settings().thresholds);
});

test('the sweep finds a threshold that fixes a systematic disagreement', () => {
  // Ten tabs you kept closing by hand, all blocked by the same wip gate.
  const labels = Array.from({ length: 10 }, (_, i) => label({
    evidenceHash: `h${i}`, verdict: 'close',
    facets: { wip: 0.4, disposable: 0.9, retrievable: 0.9, savedForLater: 0.1, dead: 0.05 },
  }));
  const before = score(labels, settings());
  assert.ok(before.falseKeep > 0, 'the current wip gate blocks them');

  const r = sweepThresholds(labels, settings());
  assert.equal(r.enoughData, true);
  assert.ok(r.best.cost < before.cost, 'the sweep must improve on the current settings');
  assert.ok(r.thresholds.wip > settings().thresholds.wip, 'by raising the wip gate');
  assert.ok(r.moves.some((m) => m.facet === 'wip'), 'and say so');
});

test('the sweep will not sacrifice a tab you said to keep', () => {
  const keepers = Array.from({ length: 8 }, (_, i) => label({
    evidenceHash: `k${i}`, verdict: 'keep',
    facets: { wip: 0.4, disposable: 0.9, retrievable: 0.9, savedForLater: 0.1, dead: 0.05 },
  }));
  const closers = Array.from({ length: 2 }, (_, i) => label({
    evidenceHash: `c${i}`, verdict: 'close',
    facets: { wip: 0.4, disposable: 0.9, retrievable: 0.9, savedForLater: 0.1, dead: 0.05 },
  }));
  const r = sweepThresholds([...keepers, ...closers], settings());
  // Identical evidence, 8 keeps vs 2 closes, and false closes cost triple: hold the line.
  assert.ok(r.thresholds.wip <= settings().thresholds.wip + 0.001, 'must not open the gate');
});

test('every sweep move is explainable', () => {
  const labels = Array.from({ length: 10 }, (_, i) => label({
    evidenceHash: `h${i}`, verdict: 'close',
    facets: { wip: 0.4, disposable: 0.9, retrievable: 0.9, savedForLater: 0.1, dead: 0.05 },
  }));
  for (const m of sweepThresholds(labels, settings()).moves) {
    assert.ok(m.facet && typeof m.from === 'number' && typeof m.to === 'number');
    assert.ok(m.fixed > 0, 'a move that fixes nothing should not be made');
  }
});

test('the sweep uses the same gate logic as a real run', () => {
  // If these ever diverge, the tuner recommends settings that behave differently live.
  const l = label({ facets: { wip: 0.4, disposable: 0.9, retrievable: 0.9, savedForLater: 0.1, dead: 0.05 } });
  const s = settings({ thresholds: { ...defaultSettings().thresholds, wip: 0.5 } });
  const direct = evaluateGates({ facets: l.facets, ageHours: l.ageHours, host: l.host, settings: s });
  assert.equal(score([l], s).agree, direct.action === l.verdict ? 1 : 0);
});

test('prune keeps the most recent opinion per tab and reason', () => {
  const old = label({ id: 'a', at: 1, reason: 'needed' });
  const recent = label({ id: 'b', at: 2, reason: 'needed' });
  const other = label({ id: 'c', at: 3, reason: 'dead' });
  const out = prune([old, recent, other], 100);
  assert.equal(out.length, 2);
  assert.ok(out.find((l) => l.id === 'b'), 'the newer opinion wins');
  assert.ok(!out.find((l) => l.id === 'a'));
});

test('prune respects the cap', () => {
  const many = Array.from({ length: 50 }, (_, i) => label({ id: `l${i}`, at: i, evidenceHash: `h${i}` }));
  assert.equal(prune(many, 10).length, 10);
});

test('previewChange reports what would flip', () => {
  const items = [
    { tabId: 1, action: 'keep', ageHours: 500, facets: { wip: 0.4, disposable: 0.9, retrievable: 0.9, savedForLater: 0.1, dead: 0.05 }, reasons: [] },
    { tabId: 2, action: 'keep', ageHours: 500, facets: { wip: 0.95, disposable: 0.9, retrievable: 0.9, savedForLater: 0.1, dead: 0.05 }, reasons: [] },
  ];
  const flips = previewChange(items, settings(), { ...defaultSettings().thresholds, wip: 0.5 });
  assert.equal(flips.toClose.length, 1, 'only the 0.4 one crosses');
  assert.equal(flips.toClose[0].tabId, 1);
});

test('previewChange ignores unjudged tabs', () => {
  const items = [{ tabId: 1, action: 'keep', ageHours: 500, facets: {}, reasons: [] }];
  const flips = previewChange(items, settings(), defaultSettings().thresholds);
  assert.equal(flips.toClose.length + flips.toKeep.length, 0);
});
