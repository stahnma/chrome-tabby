// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planAsks, chunk, foldResponse } from '../src/core/evaluate.js';
import { REQUIRED_FACETS, ASK_FACETS, NOUL_FACETS } from '../src/core/schema.js';

const MODEL = 'jev-1.13.0';
const QH = { wip: 'a', disposable: 'b', retrievable: 'c', savedForLater: 'd', category: 'e' };

const tab = (i) => ({ tabId: i, evidenceHash: `h${i}`, title: `T${i}`, url: `https://x.test/${i}` });

/** A fully-cached judgment at the current model and wording. */
function cached(over = {}) {
  const answers = {};
  for (const f of REQUIRED_FACETS) answers[f] = { v: 0.5, qh: QH[f], m: MODEL, at: 1 };
  return { url: 'u', title: 't', firstSeen: 1, lastSeen: 1, answers, ...over };
}

test('a fully cached tab is asked nothing', () => {
  const r = planAsks([tab(0)], { h0: cached() }, QH, MODEL, REQUIRED_FACETS);
  assert.equal(r.asks.length, 0);
  assert.equal(r.cachedTabs, 1);
  assert.equal(r.askedFacets, 0);
});

test('an unseen tab is asked every facet', () => {
  const r = planAsks([tab(0)], {}, QH, MODEL);
  assert.equal(r.asks.length, 1);
  assert.deepEqual(r.asks[0].facets, [...ASK_FACETS]);
});

test('rewording ONE question re-asks only that facet', () => {
  // The whole point of per-facet cache keying.
  const r = planAsks([tab(0)], { h0: cached() }, { ...QH, wip: 'REWORDED' }, MODEL, REQUIRED_FACETS);
  assert.equal(r.asks.length, 1);
  assert.deepEqual(r.asks[0].facets, ['wip'], 'the other three must stay cached');
  assert.equal(r.askedFacets, 1);
});

test('a model version bump invalidates everything', () => {
  const r = planAsks([tab(0)], { h0: cached() }, QH, 'jev-1.14.0', REQUIRED_FACETS);
  assert.deepEqual(r.asks[0].facets, [...REQUIRED_FACETS]);
});

test('a partially answered tab is asked only the gaps', () => {
  const j = cached();
  delete j.answers.retrievable;
  delete j.answers.wip;
  const r = planAsks([tab(0)], { h0: j }, QH, MODEL, REQUIRED_FACETS);
  assert.deepEqual(r.asks[0].facets.sort(), ['retrievable', 'wip']);
});

test('mixed cached and uncached tabs partition correctly', () => {
  const tabs = [tab(0), tab(1), tab(2)];
  const r = planAsks(tabs, { h0: cached(), h2: cached() }, QH, MODEL, REQUIRED_FACETS);
  assert.equal(r.cachedTabs, 2);
  assert.equal(r.asks.length, 1);
  assert.equal(r.asks[0].tab.tabId, 1);
});

test('category is not asked unless requested', () => {
  // v1 ships nouls only; category is deferred.
  const r = planAsks([tab(0)], {}, QH, MODEL);
  assert.ok(!r.asks[0].facets.includes('category'));
});

test('chunk splits evenly and keeps the remainder', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 8), []);
  assert.equal(chunk(Array.from({ length: 40 }, (_, i) => i), 8).length, 5);
});

test('chunk rejects a nonsense size rather than looping forever', () => {
  assert.throws(() => chunk([1], 0), RangeError);
});

test('foldResponse maps answers back onto the right tabs', () => {
  const group = [{ tab: tab(0), facets: ['wip'] }, { tab: tab(1), facets: ['wip'] }];
  const res = {
    model: MODEL,
    answers: { t0_wip: { type: 'noul', noul: 0.9 }, t1_wip: { type: 'noul', noul: 0.1 } },
  };
  const out = foldResponse(group, res, QH, 1000);
  assert.equal(out.h0.answers.wip.v, 0.9);
  assert.equal(out.h1.answers.wip.v, 0.1);
});

test('foldResponse stamps the model that actually answered, not the one requested', () => {
  // The API echoes a concrete version; that is what must gate the cache.
  const group = [{ tab: tab(0), facets: ['wip'] }];
  const out = foldResponse(group, { model: 'jev-1.13.0', answers: { t0_wip: { type: 'noul', noul: 0.5 } } }, QH, 1);
  assert.equal(out.h0.answers.wip.m, 'jev-1.13.0');
});

test('foldResponse ignores answers for indices not in the group', () => {
  const group = [{ tab: tab(0), facets: ['wip'] }];
  const out = foldResponse(group, { model: MODEL, answers: { t7_wip: { type: 'noul', noul: 0.5 } } }, QH, 1);
  assert.deepEqual(out, {});
});

test('a cached run after a fresh run asks nothing -- the end-to-end cache property', () => {
  const tabs = [tab(0), tab(1)];
  const first = planAsks(tabs, {}, QH, MODEL, REQUIRED_FACETS);
  assert.equal(first.asks.length, 2);

  // Simulate storing what came back.
  const group = first.asks;
  const answers = {};
  group.forEach((g, i) => {
    for (const f of g.facets) {
      answers[`t${i}_${{ wip: 'wip', disposable: 'disp', retrievable: 'retr', savedForLater: 'save' }[f]}`] =
        { type: 'noul', noul: 0.5 };
    }
  });
  const judgments = foldResponse(group, { model: MODEL, answers }, QH, 1);

  const second = planAsks(tabs, judgments, QH, MODEL, REQUIRED_FACETS);
  assert.equal(second.asks.length, 0, 'second run must be a total cache hit');
  assert.equal(second.cachedTabs, 2);
});

test('every noul facet the decision can use is actually asked', () => {
  // The bug this guards: `dead` was in the decision but not in the ask list, so it was
  // permanently undefined and its gate could never fire.
  const r = planAsks([tab(0)], {}, QH, MODEL);
  for (const f of NOUL_FACETS) {
    assert.ok(r.asks[0].facets.includes(f), `${f} must be requested`);
  }
});

test('ASK_FACETS is a superset of REQUIRED_FACETS', () => {
  for (const f of REQUIRED_FACETS) assert.ok(ASK_FACETS.includes(f), f);
});

test('a judgment cached before `dead` existed is not asked for the other four again', () => {
  const j = cached(); // has the four originals at current wording
  const r = planAsks([tab(0)], { h0: j }, QH, MODEL);
  assert.deepEqual(r.asks[0].facets, ['dead'], 'only the new facet is re-asked');
});
