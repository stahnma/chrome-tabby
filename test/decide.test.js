// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide, ageHoursOf, isDenied } from '../src/core/decide.js';
import { defaultSettings } from '../src/core/schema.js';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);
const DAY = 864e5;
const daysAgo = (n) => NOW - n * DAY;

/** @returns {import('../src/core/schema.js').TabFact & {evidenceHash:string}} */
function tab(over = {}) {
  return {
    tabId: 1,
    windowId: 10,
    evidenceHash: 'h1',
    title: 'Some page',
    url: 'https://example.com/page',
    lastAccessed: daysAgo(30),
    pinned: false,
    audible: false,
    active: false,
    windowTabCount: 12,
    ...over,
  };
}

/** A judgment that, with default thresholds, clears every gate. */
function judgment(over = {}) {
  const { firstSeen = daysAgo(60), category, ...nouls } = over;
  const vals = { wip: 0.02, disposable: 0.9, retrievable: 0.9, savedForLater: 0.05, ...nouls };
  /** @type {Record<string, any>} */
  const answers = {};
  for (const [k, v] of Object.entries(vals)) answers[k] = { v, qh: 'q', m: 'jev-1.13.0', at: firstSeen };
  if (category) answers.category = { v: category, qh: 'q', m: 'jev-1.13.0', at: firstSeen };
  return { url: 'https://example.com/page', title: 'Some page', firstSeen, lastSeen: NOW, answers };
}

function run(tabs, judgments, settingsOver = {}) {
  const settings = { ...defaultSettings(), ...settingsOver };
  return decide({ tabs, judgments, settings, now: NOW });
}

const only = (r) => r.items[0];
const codes = (d) => d.reasons.map((x) => x.code);

test('closes a stale, disposable tab', () => {
  const d = only(run([tab()], { h1: judgment() }));
  assert.equal(d.action, 'close');
  assert.ok(codes(d).includes('DISPOSABLE'));
});

test('closes via retrievable even when not disposable', () => {
  const d = only(run([tab()], { h1: judgment({ disposable: 0.1, retrievable: 0.95 }) }));
  assert.equal(d.action, 'close');
  assert.ok(codes(d).includes('RETRIEVABLE'));
});

test('keeps when neither disposable nor retrievable clears its gate', () => {
  // Escalator off, so this isolates the evidence gate from the age gate.
  const d = only(run([tab()], { h1: judgment({ disposable: 0.5, retrievable: 0.5 }) }, { staleAfterDays: 0 }));
  assert.equal(d.action, 'keep');
  assert.deepEqual(codes(d), ['NOT_DISPOSABLE_OR_RETRIEVABLE']);
});

test('work-in-progress vetoes an otherwise closeable tab', () => {
  const d = only(run([tab()], { h1: judgment({ wip: 0.9 }) }));
  assert.equal(d.action, 'keep');
  assert.deepEqual(codes(d), ['WIP']);
});

test('saved-for-later vetoes an otherwise closeable tab', () => {
  const d = only(run([tab()], { h1: judgment({ savedForLater: 0.8 }) }));
  assert.equal(d.action, 'keep');
  assert.deepEqual(codes(d), ['SAVED_FOR_LATER']);
});

test('protected category vetoes a tab that cleared every noul gate', () => {
  const d = only(run([tab()], { h1: judgment({ category: 'code_host_or_ticket' }) }));
  assert.equal(d.action, 'keep');
  assert.deepEqual(codes(d), ['PROTECTED_CATEGORY']);
});

test('an unprotected category does not veto', () => {
  const d = only(run([tab()], { h1: judgment({ category: 'search_results' }) }));
  assert.equal(d.action, 'close');
});

test('keeps a tab younger than minAgeHours', () => {
  const hoursAgo = (n) => NOW - n * 3600e3;
  const t = tab({ lastAccessed: hoursAgo(0.5) });
  const d = only(run([t], { h1: judgment({ firstSeen: hoursAgo(0.5) }) }));
  assert.equal(d.action, 'keep');
  assert.deepEqual(codes(d), ['TOO_RECENT']);
});

test('minAgeHours is an inclusive boundary', () => {
  const hoursAgo = (n) => NOW - n * 3600e3;
  const at = (h) => only(run([tab({ lastAccessed: hoursAgo(h) })],
    { h1: judgment({ firstSeen: hoursAgo(h) }) }, { minAgeHours: 24 })).action;
  assert.equal(at(23), 'keep');
  assert.equal(at(24), 'close', 'exactly at the threshold counts as old enough');
  assert.equal(at(25), 'close');
});

test('keeps a tab with no judgment at all, and names the missing facets', () => {
  const d = only(run([tab()], {}));
  assert.equal(d.action, 'keep');
  assert.deepEqual(codes(d), ['FACETS_MISSING']);
  assert.match(d.reasons[0].detail, /wip.*disposable.*retrievable.*savedForLater/);
});

test('keeps a tab whose judgment is missing one facet', () => {
  const j = judgment();
  delete j.answers.retrievable;
  const d = only(run([tab()], { h1: j }));
  assert.equal(d.action, 'keep');
  assert.match(d.reasons[0].detail, /retrievable/);
});

for (const [name, over, code] of [
  ['pinned', { pinned: true }, 'PINNED'],
  ['audible', { audible: true }, 'AUDIBLE'],
  ['active', { active: true }, 'ACTIVE'],
  ['last in its window', { windowTabCount: 1 }, 'LAST_IN_WINDOW'],
  ['a chrome:// page', { url: 'chrome://extensions' }, 'SCHEME'],
  ['a file:// page', { url: 'file:///tmp/x.html' }, 'SCHEME'],
  ['a denylisted host', { url: 'https://mail.google.com/u/0' }, 'DENYLIST'],
]) {
  test(`never closes ${name}`, () => {
    const d = only(run([tab(over)], { h1: judgment() }));
    assert.equal(d.action, 'keep');
    assert.deepEqual(codes(d), [code]);
  });
}

test('hard skips outrank every model signal', () => {
  // Maximally closeable judgment, but the tab is pinned.
  const j = judgment({ wip: 0, disposable: 1, retrievable: 1, savedForLater: 0 });
  assert.equal(only(run([tab({ pinned: true })], { h1: j })).action, 'keep');
});

test('debug.limitToWindowId confines closing to one window', () => {
  const tabs = [tab({ tabId: 1, windowId: 10 }), tab({ tabId: 2, windowId: 20 })];
  const r = run(tabs, { h1: judgment() }, { debug: { nowOffsetHours: 0, limitToWindowId: 20 } });
  assert.equal(r.items.find((d) => d.tabId === 1).action, 'keep');
  assert.equal(r.items.find((d) => d.tabId === 2).action, 'close');
});

test('maxClosesPerRun caps the blast radius and keeps the oldest', () => {
  const tabs = [10, 40, 20, 30].map((d, i) =>
    tab({ tabId: i, evidenceHash: `h${i}`, lastAccessed: daysAgo(d) }));
  const judgments = Object.fromEntries(
    tabs.map((t, i) => [`h${i}`, judgment({ firstSeen: t.lastAccessed })]));

  const r = run(tabs, judgments, { maxClosesPerRun: 2 });
  assert.equal(r.closeCount, 2);

  const closed = r.items.filter((d) => d.action === 'close').map((d) => d.tabId).sort();
  assert.deepEqual(closed, [1, 3], 'the 40- and 30-day-old tabs, not the recent ones');

  const capped = r.items.filter((d) => codes(d).includes('CAP_REACHED'));
  assert.equal(capped.length, 2);
});

test('counts add up to the number of tabs', () => {
  const tabs = [tab({ tabId: 1 }), tab({ tabId: 2, pinned: true })];
  const r = run(tabs, { h1: judgment() });
  assert.equal(r.closeCount + r.keepCount, r.items.length);
  assert.equal(r.items.length, 2);
});

test('does not mutate its inputs', () => {
  const tabs = [tab()];
  const judgments = { h1: judgment() };
  const before = JSON.stringify({ tabs, judgments });
  run(tabs, judgments);
  assert.equal(JSON.stringify({ tabs, judgments }), before);
});

test('is deterministic', () => {
  const args = [[tab()], { h1: judgment() }];
  assert.deepEqual(run(...args), run(...args));
});

test('lowering a threshold flips a keep to a close without re-asking the model', () => {
  // The whole point of storing raw judgments: retuning is a pure replay.
  const j = { h1: judgment({ disposable: 0.5, retrievable: 0.5 }) };
  assert.equal(only(run([tab()], j, { staleAfterDays: 0 })).action, 'keep');
  const relaxed = { ...defaultSettings().thresholds, disposable: 0.4 };
  assert.equal(only(run([tab()], j, { staleAfterDays: 0, thresholds: relaxed })).action, 'close');
});

test('ageHoursOf uses firstSeen when lastAccessed looks suspiciously fresh', () => {
  // Session restore can reset lastAccessed on a tab that has really been open for months.
  const t = tab({ lastAccessed: daysAgo(1) });
  const j = judgment({ firstSeen: daysAgo(90) });
  assert.equal(Math.round(ageHoursOf(t, j, NOW)), 90 * 24);
});

test('ageHoursOf falls back to lastAccessed with no judgment', () => {
  assert.equal(Math.round(ageHoursOf(tab({ lastAccessed: daysAgo(5) }), undefined, NOW)), 120);
});

test('ageHoursOf never goes negative for a future timestamp', () => {
  assert.equal(ageHoursOf(tab({ lastAccessed: NOW + DAY }), undefined, NOW), 0);
});

test('a restored-looking tab still closes on the firstSeen floor', () => {
  const t = tab({ lastAccessed: daysAgo(1) });
  const d = only(run([t], { h1: judgment({ firstSeen: daysAgo(90) }) }));
  assert.equal(d.action, 'close', 'age floor should defeat the fresh lastAccessed');
});

test('isDenied matches on label boundaries only', () => {
  assert.ok(isDenied('mail.google.com', ['mail.google.com']));
  assert.ok(isDenied('deep.mail.google.com', ['mail.google.com']));
  assert.ok(isDenied('EVIL.COM', ['evil.com']), 'case insensitive');
  assert.ok(isDenied('evil.com', ['.evil.com']), 'leading dot tolerated');
  assert.ok(!isDenied('notevil.com', ['evil.com']), 'must not match a suffix mid-label');
  assert.ok(!isDenied('example.com', []));
  assert.ok(!isDenied('example.com', ['']), 'empty entry must not match everything');
});

test('a very stale tab closes without needing to look disposable', () => {
  // Age is evidence. The wip and savedForLater vetoes have already done the protecting.
  const t = tab({ lastAccessed: daysAgo(30) });
  const j = judgment({ disposable: 0.4, retrievable: 0.4, firstSeen: daysAgo(30) });
  const d = only(run([t], { h1: j }, { staleAfterDays: 14 }));
  assert.equal(d.action, 'close');
  assert.ok(codes(d).includes('VERY_STALE'));
});

test('the stale escalator does not override the work-in-progress veto', () => {
  const t = tab({ lastAccessed: daysAgo(90) });
  const j = judgment({ wip: 0.9, disposable: 0.4, retrievable: 0.4, firstSeen: daysAgo(90) });
  assert.equal(only(run([t], { h1: j }, { staleAfterDays: 14 })).action, 'keep');
});

test('the stale escalator does not override saved-for-later', () => {
  const t = tab({ lastAccessed: daysAgo(90) });
  const j = judgment({ savedForLater: 0.9, disposable: 0.4, retrievable: 0.4, firstSeen: daysAgo(90) });
  assert.equal(only(run([t], { h1: j }, { staleAfterDays: 14 })).action, 'keep');
});

test('the stale escalator does not override a hard skip', () => {
  const t = tab({ lastAccessed: daysAgo(90), pinned: true });
  const j = judgment({ disposable: 0.4, retrievable: 0.4, firstSeen: daysAgo(90) });
  assert.equal(only(run([t], { h1: j }, { staleAfterDays: 14 })).action, 'keep');
});

test('a middling tab below the stale mark is still kept', () => {
  const t = tab({ lastAccessed: daysAgo(5) });
  const j = judgment({ disposable: 0.4, retrievable: 0.4, firstSeen: daysAgo(5) });
  const d = only(run([t], { h1: j }, { staleAfterDays: 14 }));
  assert.equal(d.action, 'keep');
  assert.deepEqual(codes(d), ['NOT_DISPOSABLE_OR_RETRIEVABLE']);
});

test('staleAfterDays: 0 disables the escalator entirely', () => {
  const t = tab({ lastAccessed: daysAgo(400) });
  const j = judgment({ disposable: 0.4, retrievable: 0.4, firstSeen: daysAgo(400) });
  assert.equal(only(run([t], { h1: j }, { staleAfterDays: 0 })).action, 'keep');
});

test('a dead page closes even though it looks like work in progress', () => {
  // The reported failure: a "page not found" at a ticket-shaped URL was kept as WIP.
  const j = judgment({ dead: 0.94, wip: 0.9, disposable: 0.4, retrievable: 0.4 });
  const d = only(run([tab()], { h1: j }));
  assert.equal(d.action, 'close');
  assert.ok(codes(d).includes('DEAD'));
});

test('a logged-out page closes even though it looks saved for later', () => {
  const j = judgment({ dead: 0.88, savedForLater: 0.95, disposable: 0.3, retrievable: 0.3 });
  assert.equal(only(run([tab()], { h1: j })).action, 'close');
});

test('a dead page still respects hard skips', () => {
  const j = judgment({ dead: 0.99 });
  for (const over of [{ pinned: true }, { active: true }, { audible: true }, { windowTabCount: 1 }]) {
    assert.equal(only(run([tab(over)], { h1: j })).action, 'keep', JSON.stringify(over));
  }
});

test('a dead page still respects the minimum age', () => {
  // You may be looking at the 404 right now.
  const t = tab({ lastAccessed: NOW - 0.5 * 3600e3 });
  const j = judgment({ dead: 0.99, firstSeen: NOW - 0.5 * 3600e3 });
  assert.equal(only(run([t], { h1: j })).action, 'keep');
});

test('a live page is unaffected by the dead gate', () => {
  const j = judgment({ dead: 0.02, wip: 0.9 });
  assert.equal(only(run([tab()], { h1: j })).action, 'keep', 'wip veto still applies');
});

test('an old judgment without the dead facet still decides', () => {
  // `dead` is additive, so a cached judgment from before it existed must not stall.
  const j = judgment();
  delete j.answers.dead;
  assert.equal(only(run([tab()], { h1: j })).action, 'close');
});
