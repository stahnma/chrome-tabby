// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildQuestions, buildState, parseAnswers, questionHashes, FACETS } from '../src/core/questions.js';
import { NOUL_FACETS, CATEGORIES } from '../src/core/schema.js';

const ALL = [...NOUL_FACETS, 'category'];

test('builds one question per tab per facet', () => {
  const q = buildQuestions([{ facets: ALL }, { facets: ALL }]);
  assert.equal(Object.keys(q).length, ALL.length * 2);
});

test('only asks the facets a tab actually needs', () => {
  // The per-facet cache means a tab may need just one question re-asked.
  const q = buildQuestions([{ facets: ['wip'] }]);
  assert.deepEqual(Object.keys(q), ['t0_wip']);
});

test('every instruction names its own index, since ids are not sent to the model', () => {
  const q = buildQuestions([{ facets: ALL }, { facets: ALL }]);
  for (const [key, def] of Object.entries(q)) {
    const i = /^t(\d+)_/.exec(key)[1];
    assert.ok(def.instructions.includes(`tabs[${i}].title`), `${key} must reference tabs[${i}]`);
    assert.ok(def.instructions.includes(`tabs[${i}].url`), `${key} must reference tabs[${i}]`);
  }
});

test('no instruction leaks a question id', () => {
  const q = buildQuestions([{ facets: ALL }]);
  for (const [key, def] of Object.entries(q)) {
    assert.ok(!def.instructions.includes(key), `${key} appears in its own instructions`);
  }
});

test('nouls carry a true/false rubric; the choice carries all categories', () => {
  const SL = { wip: 'wip', disposable: 'disp', retrievable: 'retr', savedForLater: 'save', dead: 'dead' };
  const q = buildQuestions([{ facets: ALL }]);
  for (const f of NOUL_FACETS) {
    const def = q[`t0_${SL[f]}`];
    assert.equal(def.type, 'noul', f);
    assert.deepEqual(Object.keys(def.criteria).sort(), ['false', 'true'], `${f} rubric`);
  }
  assert.equal(q.t0_cat.type, 'choice');
  assert.deepEqual(q.t0_cat.criteria, CATEGORIES);
  assert.ok(CATEGORIES.length < 255, 'choice caps at 255 options');
});

test('state lines up index-for-index with the questions', () => {
  const tabs = [
    { title: 'One', url: 'https://a.test/1', lastAccessed: 5 },
    { title: 'Two', url: 'https://b.test/2', lastAccessed: 9 },
  ];
  const state = buildState(tabs);
  assert.deepEqual(state.tabs, [
    { title: 'One', url: 'https://a.test/1' },
    { title: 'Two', url: 'https://b.test/2' },
  ]);
});

test('state carries no time-varying fields', () => {
  // If lastAccessed ever lands in the state, the evidence hash churns nightly.
  const state = buildState([{ title: 'T', url: 'https://a.test/1', lastAccessed: 5, pinned: true }]);
  assert.deepEqual(Object.keys(state.tabs[0]).sort(), ['title', 'url']);
});

test('parses noul answers back to (index, facet) pairs', () => {
  const parsed = parseAnswers({
    answers: {
      t0_wip: { type: 'noul', noul: 0.91 },
      t1_disp: { type: 'noul', noul: 0.04 },
    },
  });
  assert.deepEqual(parsed.sort((a, b) => a.index - b.index), [
    { index: 0, facet: 'wip', value: 0.91 },
    { index: 1, facet: 'disposable', value: 0.04 },
  ]);
});

test('parses a choice answer to its chosen option', () => {
  const parsed = parseAnswers({
    answers: { t2_cat: { type: 'choice', choice: 'code_host_or_ticket', probabilities: {}, confidence: 0.8 } },
  });
  assert.deepEqual(parsed, [{ index: 2, facet: 'category', value: 'code_host_or_ticket' }]);
});

test('parse round-trips every key buildQuestions emits', () => {
  const chunk = [{ facets: ALL }, { facets: ALL }, { facets: ALL }];
  const keys = Object.keys(buildQuestions(chunk));
  const fake = { answers: Object.fromEntries(keys.map((k) => [k, { type: k.endsWith('_cat') ? 'choice' : 'noul', noul: 0.5, choice: 'other' }])) };
  assert.equal(parseAnswers(fake).length, keys.length, 'every emitted key must parse back');
});

test('parse ignores unknown or malformed keys rather than throwing', () => {
  assert.deepEqual(parseAnswers({ answers: { garbage: { type: 'noul', noul: 1 } } }), []);
  assert.deepEqual(parseAnswers({ answers: { t0_nope: { type: 'noul', noul: 1 } } }), []);
  assert.deepEqual(parseAnswers({}), []);
});

test('parse skips answers with no usable value', () => {
  assert.deepEqual(parseAnswers({ answers: { t0_wip: { type: 'noul' } } }), []);
});

test('question hashes are stable and distinct per facet', async () => {
  const a = await questionHashes();
  const b = await questionHashes();
  assert.deepEqual(a, b);
  assert.equal(new Set(Object.values(a)).size, Object.keys(FACETS).length, 'no two facets share a hash');
});

test('question hash does not depend on chunk position', async () => {
  // Otherwise a tab landing at a different index would look like a cache miss.
  const q = buildQuestions([{ facets: ['wip'] }, { facets: ['wip'] }]);
  const strip = (s) => s.replace(/tabs\[\d+\]/g, 'tabs[i]');
  assert.equal(strip(q.t0_wip.instructions), strip(q.t1_wip.instructions));
});

// The wording below carries real product decisions that were arrived at from observed
// misjudgments. These guard against a future reword silently dropping one.
test('wip rules out pages that cannot be worked on', () => {
  const { instructions, criteria } = FACETS.wip;
  const text = (instructions(0) + JSON.stringify(criteria)).toLowerCase();
  assert.match(text, /no longer exists|not found|404/, 'dead pages are not work in progress');
  assert.match(text, /sign-in|sign in|login/, 'nor are expired-session login walls');
});

test('disposable claims dead and logged-out pages', () => {
  const { instructions, criteria } = FACETS.disposable;
  const text = (instructions(0) + JSON.stringify(criteria)).toLowerCase();
  assert.match(text, /error|not-found|not found/, 'error pages are disposable');
  assert.match(text, /login|sign-in|sign in/, 'so are expired-session login screens');
  assert.match(text, /expired/, 'and the expiry case is named explicitly');
});

test('every noul ships a true/false rubric', () => {
  for (const f of NOUL_FACETS) {
    const c = FACETS[f].criteria;
    assert.ok(c && 'true' in c && 'false' in c, `${f} needs both sides of the rubric`);
  }
});

test('changing criteria changes that facet’s cache key', async () => {
  // Otherwise a tightened rubric would silently reuse answers from the looser one.
  const before = (await questionHashes()).wip;
  const original = FACETS.wip.criteria;
  FACETS.wip.criteria = { true: 'x', false: 'y' };
  const after = (await questionHashes()).wip;
  FACETS.wip.criteria = original;
  assert.notEqual(before, after);
});
