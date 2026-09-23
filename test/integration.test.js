// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installFakeChrome, fakeTab } from './fakeChrome.js';

const DAY = 864e5;
const old = (d) => Date.now() - d * DAY;

/** A realistic spread: junk, docs, an open PR, a pinned tab, and the active tab. */
function scenario() {
  return [
    fakeTab({ id: 1, title: 'kittens - Google Search', url: 'https://www.google.com/search?q=kittens', lastAccessed: old(40) }),
    fakeTab({ id: 2, title: 'chrome.alarms | Chrome Extensions', url: 'https://developer.chrome.com/docs/extensions/reference/api/alarms', lastAccessed: old(35) }),
    fakeTab({ id: 3, title: 'Add backoff · Pull Request #12', url: 'https://github.com/foo/bar/pull/12', lastAccessed: old(20) }),
    fakeTab({ id: 4, title: 'Pinned thing', url: 'https://example.com/pinned', pinned: true, lastAccessed: old(99) }),
    fakeTab({ id: 5, title: 'Active thing', url: 'https://example.com/active', active: true, lastAccessed: old(99) }),
    fakeTab({ id: 6, title: 'Hacker News', url: 'https://news.ycombinator.com/', lastAccessed: old(10) }),
    fakeTab({ id: 7, title: 'Fresh', url: 'https://example.com/fresh', lastAccessed: Date.now() - 3600e3 }),
  ];
}

async function freshModules() {
  // Cache-bust so each test gets its own module state alongside its own fake chrome.
  const q = `?t=${Math.random()}`;
  return {
    run: await import(`../src/core/run.js${q}`),
    storage: await import(`../src/core/storage.js${q}`),
  };
}

test('a full shadow run over a realistic tab set', async () => {
  const env = installFakeChrome({ tabs: scenario() });
  const { run, storage } = await freshModules();
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' }, shadowMode: true });

  const summary = await run.runNow();

  assert.equal(summary.mode, 'shadow');
  assert.equal(summary.tabs, 7);
  assert.equal(summary.closed, 0, 'shadow mode must never close anything');
  assert.equal(env.removed.length, 0, 'and must not call tabs.remove');

  const proposal = await storage.getProposal();
  assert.equal(proposal.items.length, 7);
  assert.equal(proposal.mode, 'shadow');

  const byId = Object.fromEntries(proposal.items.map((d) => [d.tabId, d]));
  assert.equal(byId[4].action, 'keep', 'pinned');
  assert.equal(byId[5].action, 'keep', 'active');
  assert.equal(byId[7].action, 'keep', 'too recent');
  assert.equal(byId[1].action, 'close', 'a 40-day-old search results page should go');
});

test('the second run is a total cache hit', async () => {
  installFakeChrome({ tabs: scenario() });
  const { run, storage } = await freshModules();
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' } });

  const first = await run.runNow();
  assert.ok(first.askedTabs > 0, 'first run asks');

  const second = await run.runNow();
  assert.equal(second.askedTabs, 0, 'second run must ask nothing');
  assert.equal(second.cachedTabs, 7);
  assert.equal(second.chunks, 0, 'and therefore issue no requests');
});

test('live mode archives before it closes, and the archive round-trips', async () => {
  const env = installFakeChrome({ tabs: scenario() });
  const { run, storage } = await freshModules();
  const archive = await import('../src/core/archive.js');
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' }, shadowMode: false });

  const summary = await run.runNow();
  assert.ok(summary.closed > 0, 'live mode should actually close something');
  assert.equal(env.removed.length, summary.closed);

  const stored = await storage.getArchive();
  assert.equal(stored.length, summary.closed, 'every closed tab is archived');
  for (const e of stored) {
    assert.ok(e.url.startsWith('http'), 'archived url is usable');
    assert.ok(!e.url.includes('?'), 'and sanitized');
    assert.ok(e.answersSnapshot && Object.keys(e.answersSnapshot).length, 'with the judgment that killed it');
  }

  await archive.restore(stored[0].id);
  assert.equal(env.created.length, 1, 'restore reopens the tab');
  assert.equal(env.created[0].active, false, 'unfocused');
  assert.equal(env.created[0].url, stored[0].url);

  const settings = await storage.getSettings();
  assert.equal(settings.hasVerifiedRestore, true, 'restoring unlocks the live-mode gate');
});

test('nothing sensitive reaches the transport', async () => {
  const tabs = [fakeTab({
    id: 1, lastAccessed: old(40),
    title: 'Billing',
    url: 'https://internal.example.com/dash?token=SUPERSECRET&user=michaels#tab=billing',
  })];
  installFakeChrome({ tabs });
  const { run, storage } = await freshModules();

  // Wrap the mock so we can inspect exactly what would have gone over the wire.
  const seen = [];
  const { makeMock } = await import('../src/transport/mock.js');
  const inner = makeMock();
  const transportModule = await import('../src/transport/index.js');
  const original = transportModule.makeTransport;

  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' } });
  const { evaluate } = await import('../src/core/evaluate.js');
  const { snapshot } = await import('../src/core/tabs.js');
  await evaluate({
    tabs: await snapshot(),
    judgments: {},
    settings: await storage.getSettings(),
    transport: { async ask(req) { seen.push(req); return inner.ask(req); } },
  });

  const wire = JSON.stringify(seen);
  assert.ok(!wire.includes('SUPERSECRET'), 'query-string token must never leave');
  assert.ok(!wire.includes('michaels'), 'nor the user parameter');
  assert.ok(!wire.includes('tab=billing'), 'nor the fragment');
  assert.ok(wire.includes('internal.example.com/dash'), 'origin + path does go, by design');
  assert.ok(!wire.includes('lastAccessed'), 'no time-varying field in the state');
});

test('a transport failure keeps every tab rather than closing blind', async () => {
  const env = installFakeChrome({ tabs: scenario() });
  const { run, storage } = await freshModules();
  await storage.patchSettings({ shadowMode: false, transport: { mode: 'direct', proxyUrl: '' } });
  await storage.setApiKey(''); // direct with no key -> every chunk fails

  const summary = await run.runNow();
  assert.equal(summary.closed, 0, 'no judgments means no closes');
  assert.equal(env.removed.length, 0);
  assert.ok(summary.failed.length > 0, 'and the failure is recorded, not swallowed');
});

test('the per-run cap is enforced end to end', async () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    fakeTab({ id: i + 1, title: `Search ${i}`, url: `https://www.google.com/search?q=${i}`, lastAccessed: old(50 + i) }));
  const env = installFakeChrome({ tabs: many });
  const { run, storage } = await freshModules();
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' }, shadowMode: false, maxClosesPerRun: 5 });

  const summary = await run.runNow();
  assert.equal(summary.closed, 5);
  assert.equal(env.removed.length, 5);
});

test('a run records token usage so cost is observable', async () => {
  installFakeChrome({ tabs: scenario() });
  const { run, storage } = await freshModules();
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' } });

  const summary = await run.runNow();
  assert.ok(typeof summary.tokens === 'number');
  const log = await storage.getRunLog();
  assert.equal(log[0].runId, summary.runId);
});

test('an alias model self-heals into a concrete pin', async () => {
  // Left as 'jev-latest', every run would be a total cache miss: the API stamps a concrete
  // version on each answer, which can never equal the alias. The run must re-pin itself.
  installFakeChrome({ tabs: scenario() });
  const { run, storage } = await freshModules();
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' }, model: 'jev-latest' });

  await run.runNow();
  const after = await storage.getSettings();
  assert.notEqual(after.model, 'jev-latest', 'the alias must not survive a run');

  const second = await run.runNow();
  assert.equal(second.askedTabs, 0, 'and the next run must then be a cache hit');
});

test('re-pin resolves a concrete version', async () => {
  installFakeChrome({ tabs: scenario() });
  const { run, storage } = await freshModules();
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' }, model: 'jev-latest' });

  const { model } = await run.repin();
  assert.ok(model && model !== 'jev-latest');
  assert.equal((await storage.getSettings()).model, model);
});

test('manual close works when tab ids are stale after a restart', async () => {
  // tab.id is session-scoped. A proposal staged before a browser restart holds ids that no
  // longer resolve; closing must fall back to the URL rather than silently doing nothing.
  const env = installFakeChrome({ tabs: [fakeTab({ id: 77, title: 'Junk', url: 'https://x.test/junk' })] });
  const { storage } = await freshModules();
  const { closeTabs } = await import('../src/core/execute.js');

  await storage.setProposal({
    runId: 'r1', createdAt: Date.now(), mode: 'shadow',
    items: [{
      tabId: 12, // the pre-restart id; the live tab is now 77
      windowId: 10, evidenceHash: 'h', title: 'Junk', url: 'https://x.test/junk',
      ageHours: 50, facets: {}, action: 'close', reasons: [],
    }],
  });

  const r = await closeTabs([12]);
  assert.equal(r.closed, 1, 'must resolve the tab by url');
  assert.equal(env.removed[0].id, 77, 'and close the live one');
  assert.equal(r.missing, 0);
});

test('manual close reports tabs that are genuinely gone', async () => {
  const env = installFakeChrome({ tabs: [] });
  const { storage } = await freshModules();
  const { closeTabs } = await import('../src/core/execute.js');

  await storage.setProposal({
    runId: 'r1', createdAt: Date.now(), mode: 'shadow',
    items: [{ tabId: 5, windowId: 1, evidenceHash: 'h', title: 'Gone', url: 'https://x.test/gone', ageHours: 50, facets: {}, action: 'close', reasons: [] }],
  });

  const r = await closeTabs([5]);
  assert.equal(r.closed, 0);
  assert.equal(r.missing, 1, 'reported, not swallowed');
  assert.equal(env.removed.length, 0);

  const after = await storage.getProposal();
  assert.equal(after.items.length, 0, 'and dropped from the proposal either way');
});

test('manual close archives, so it is still undoable', async () => {
  const env = installFakeChrome({ tabs: [fakeTab({ id: 3, title: 'Bye', url: 'https://x.test/bye' })] });
  const { storage } = await freshModules();
  const { closeTabs } = await import('../src/core/execute.js');
  await storage.setProposal({
    runId: 'r1', createdAt: Date.now(), mode: 'shadow',
    items: [{ tabId: 3, windowId: 10, evidenceHash: 'h', title: 'Bye', url: 'https://x.test/bye', ageHours: 50, facets: {}, action: 'close', reasons: [] }],
  });

  await closeTabs([3]);
  const archive = await storage.getArchive();
  assert.equal(archive.length, 1);
  assert.equal(archive[0].url, 'https://x.test/bye');
  assert.equal(env.removed.length, 1);
});

test('manual close of several tabs closes all of them', async () => {
  const tabs = [1, 2, 3].map((i) => fakeTab({ id: i, url: `https://x.test/${i}` }));
  const env = installFakeChrome({ tabs });
  const { storage } = await freshModules();
  const { closeTabs } = await import('../src/core/execute.js');
  await storage.setProposal({
    runId: 'r1', createdAt: Date.now(), mode: 'shadow',
    items: tabs.map((t) => ({ tabId: t.id, windowId: 10, evidenceHash: `h${t.id}`, title: 'x', url: t.url, ageHours: 50, facets: {}, action: 'close', reasons: [] })),
  });

  const r = await closeTabs([1, 2, 3]);
  assert.equal(r.closed, 3);
  assert.equal(env.removed.length, 3);
  assert.equal((await storage.getProposal()).items.length, 0);
});

test('a real run fills in every noul facet, dead included', async () => {
  installFakeChrome({ tabs: scenario() });
  const { run, storage } = await freshModules();
  const { NOUL_FACETS } = await import('../src/core/schema.js');
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' } });

  await run.runNow();
  const judgments = await storage.getJudgments();
  const judged = Object.values(judgments).filter((j) => Object.keys(j.answers).length);
  assert.ok(judged.length > 0, 'something was judged');

  for (const j of judged) {
    for (const f of NOUL_FACETS) {
      assert.ok(f in j.answers, `${f} missing from a stored judgment`);
    }
  }
});

test('a dead-looking tab reaches the close list end to end', async () => {
  const env = installFakeChrome({ tabs: [
    fakeTab({ id: 1, title: 'Page not found', url: 'https://github.com/foo/bar/pull/99999', lastAccessed: old(40) }),
    fakeTab({ id: 2, title: 'Sign in to continue', url: 'https://mychart.example.com/login', lastAccessed: old(20) }),
    fakeTab({ id: 3, title: 'Keep me', url: 'https://example.com/real', lastAccessed: old(20) }),
    fakeTab({ id: 4, title: 'Active', url: 'https://example.com/active', active: true }),
  ]});
  const { run, storage } = await freshModules();
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' }, shadowMode: true });

  await run.runNow();
  const proposal = await storage.getProposal();
  const byId = Object.fromEntries(proposal.items.map((d) => [d.tabId, d]));

  assert.equal(byId[1].action, 'close', 'a 404 at a ticket-shaped URL must close');
  assert.ok(byId[1].reasons.some((r) => r.code === 'DEAD'), 'and for the right reason');
  assert.equal(byId[2].action, 'close', 'a logged-out sign-in page must close');
  assert.ok(byId[2].reasons.some((r) => r.code === 'DEAD'));
  assert.equal(byId[4].action, 'keep', 'the active tab is still untouchable');
});

test('the archive records who closed each tab', async () => {
  const tabs = [1, 2].map((i) => fakeTab({ id: i, url: `https://www.google.com/search?q=${i}`, lastAccessed: old(50) }));
  installFakeChrome({ tabs });
  const { run, storage } = await freshModules();
  const { closeTabs } = await import('../src/core/execute.js');
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' }, shadowMode: false, maxClosesPerRun: 1 });

  await run.runNow();                       // closes one automatically
  const afterAuto = await storage.getArchive();
  assert.equal(afterAuto.length, 1);
  assert.equal(afterAuto[0].by, 'auto');

  const survivor = (await storage.getProposal()).items.find((d) => d.action === 'keep');
  await closeTabs([survivor.tabId]);        // and one by hand
  const both = await storage.getArchive();
  assert.equal(both.length, 2);
  assert.deepEqual(both.map((e) => e.by).sort(), ['auto', 'manual']);
});

test('a manual close becomes a label the tuner can use', async () => {
  const tabs = [1, 2].map((i) => fakeTab({ id: i, title: `Junk ${i}`, url: `https://x.test/${i}`, lastAccessed: old(40) }));
  installFakeChrome({ tabs });
  const { run, storage } = await freshModules();
  const { closeTabs } = await import('../src/core/execute.js');
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' }, shadowMode: true });

  await run.runNow();
  const kept = (await storage.getProposal()).items.filter((d) => d.action === 'keep' && d.facets?.wip !== undefined);
  if (!kept.length) return; // nothing was kept, nothing to label

  await closeTabs([kept[0].tabId]);
  const labels = await storage.getFeedback();
  assert.equal(labels.length, 1, 'closing by hand records one label');
  assert.equal(labels[0].verdict, 'close', 'saying the thresholds missed it');
  assert.equal(labels[0].reason, 'missed');
  assert.ok(typeof labels[0].facets.wip === 'number', 'with the judgment attached, so it can be scored');
});

test('restoring records the opposite label', async () => {
  installFakeChrome({ tabs: [fakeTab({ id: 1, title: 'Wanted', url: 'https://www.google.com/search?q=x', lastAccessed: old(50) })] });
  const { run, storage } = await freshModules();
  const archive = await import('../src/core/archive.js');
  await storage.patchSettings({ transport: { mode: 'mock', proxyUrl: '' }, shadowMode: false });

  await run.runNow();
  const stored = await storage.getArchive();
  if (!stored.length) return;

  await archive.restore(stored[0].id);
  const labels = await storage.getFeedback();
  const needed = labels.find((l) => l.reason === 'needed');
  assert.ok(needed, 'a restore says it closed something wanted');
  assert.equal(needed.verdict, 'keep');
});

test('"never close this site" takes effect immediately', async () => {
  installFakeChrome({ tabs: [fakeTab({ id: 1, url: 'https://keepme.test/page', lastAccessed: old(50) })] });
  const { storage } = await freshModules();
  const { recordFeedback } = await import('../src/core/record.js');

  await recordFeedback({ evidenceHash: 'h', url: 'https://keepme.test/page', reason: 'never' });
  const settings = await storage.getSettings();
  assert.ok(settings.denylist.includes('keepme.test'), 'the host is on the never-close list');
});

test('"always close this site" outranks the model', async () => {
  const { storage } = await freshModules();
  const { recordFeedback } = await import('../src/core/record.js');
  const { evaluateGates } = await import('../src/core/decide.js');

  await recordFeedback({ evidenceHash: 'h', url: 'https://junk.test/x', reason: 'always' });
  const settings = await storage.getSettings();
  assert.ok(settings.alwaysCloseHosts.includes('junk.test'));

  // Maximally keep-ish judgment; the explicit rule still wins.
  const g = evaluateGates({
    facets: { wip: 0.99, savedForLater: 0.99, disposable: 0.01, retrievable: 0.01, dead: 0 },
    ageHours: 500, host: 'junk.test', settings,
  });
  assert.equal(g.action, 'close');
  assert.equal(g.reasons[0].code, 'ALWAYS_CLOSE_HOST');
});

test('an always-close host still respects hard skips and minimum age', async () => {
  const { storage } = await freshModules();
  const { recordFeedback } = await import('../src/core/record.js');
  const { evaluateGates, decide } = await import('../src/core/decide.js');
  await recordFeedback({ evidenceHash: 'h', url: 'https://junk.test/x', reason: 'always' });
  const settings = await storage.getSettings();

  const fresh = evaluateGates({
    facets: { wip: 0.1, savedForLater: 0.1, disposable: 0.9, retrievable: 0.9, dead: 0 },
    ageHours: 0.1, host: 'junk.test', settings,
  });
  assert.equal(fresh.action, 'keep', 'too recent still wins');

  const pinned = decide({
    tabs: [{ tabId: 1, windowId: 1, evidenceHash: 'h', title: 'T', url: 'https://junk.test/x',
             lastAccessed: 0, pinned: true, audible: false, active: false, windowTabCount: 5 }],
    judgments: { h: { url: '', title: '', firstSeen: 0, lastSeen: 0, answers: {
      wip: { v: 0.1 }, savedForLater: { v: 0.1 }, disposable: { v: 0.9 }, retrievable: { v: 0.9 }, dead: { v: 0 } } } },
    settings, now: Date.now(),
  });
  assert.equal(pinned.items[0].action, 'keep', 'pinned still wins');
});

test('focusTab activates the tab and its window', async () => {
  const env = installFakeChrome({ tabs: [fakeTab({ id: 7, windowId: 3, url: 'https://x.test/a' })] });
  const updates = [];
  const winUpdates = [];
  globalThis.chrome.tabs.update = async (id, props) => { updates.push({ id, props }); };
  globalThis.chrome.windows = { update: async (id, props) => { winUpdates.push({ id, props }); } };

  const { focusTab } = await import(`../src/ui/close.js?t=${Math.random()}`);
  const r = await focusTab({ tabId: 7, url: 'https://x.test/a' });

  assert.equal(r.ok, true);
  assert.deepEqual(updates, [{ id: 7, props: { active: true } }]);
  assert.deepEqual(winUpdates, [{ id: 3, props: { focused: true } }], 'the window must come forward too');
});

test('focusTab finds the tab by url when the id is stale', async () => {
  // Same restart problem the close path had: every id in a staged proposal is renumbered.
  installFakeChrome({ tabs: [fakeTab({ id: 99, windowId: 4, url: 'https://x.test/a?tracking=1' })] });
  const updates = [];
  globalThis.chrome.tabs.update = async (id, props) => { updates.push({ id, props }); };
  globalThis.chrome.windows = { update: async () => {} };

  const { focusTab } = await import(`../src/ui/close.js?t=${Math.random()}`);
  const r = await focusTab({ tabId: 12, url: 'https://x.test/a' });

  assert.equal(r.ok, true);
  assert.equal(updates[0].id, 99, 'matched on the sanitized url, not the dead id');
});

test('focusTab reports a tab that is genuinely gone', async () => {
  installFakeChrome({ tabs: [] });
  globalThis.chrome.tabs.update = async () => { throw new Error('should not be called'); };
  globalThis.chrome.windows = { update: async () => {} };

  const { focusTab } = await import(`../src/ui/close.js?t=${Math.random()}`);
  const r = await focusTab({ tabId: 1, url: 'https://x.test/gone' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no longer open/);
});
