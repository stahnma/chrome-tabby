// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseAnswers } from '../src/core/questions.js';
import { makeMock } from '../src/transport/mock.js';
import { buildQuestions, buildState } from '../src/core/questions.js';
import { NOUL_FACETS } from '../src/core/schema.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/response-jev-1.13.0.json', import.meta.url), 'utf8'));

test('parses the golden response shape', () => {
  const parsed = parseAnswers(golden);
  assert.equal(parsed.length, 9);
  const t0 = Object.fromEntries(parsed.filter((p) => p.index === 0).map((p) => [p.facet, p.value]));
  assert.equal(t0.wip, 0.91);
  assert.equal(t0.savedForLater, 0.12);
  assert.equal(t0.category, 'code_host_or_ticket');
});

test('a noul answer carries no confidence field, per the API contract', () => {
  assert.ok(!('confidence' in golden.answers.t0_wip));
  assert.ok('confidence' in golden.answers.t0_cat, 'choice does carry one');
});

test('choice probabilities sum to ~1', () => {
  const sum = Object.values(golden.answers.t0_cat.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6, `got ${sum}`);
});

test('mock transport answers every question it is asked', async () => {
  const tabs = [
    { title: 'foo/bar PR 12', url: 'https://github.com/foo/bar/pull/12' },
    { title: 'chrome.alarms docs', url: 'https://developer.chrome.com/docs/extensions/reference/api/alarms' },
    { title: 'kitten pictures - Google Search', url: 'https://www.google.com/search' },
  ];
  const questions = buildQuestions(tabs.map(() => ({ facets: NOUL_FACETS })));
  const res = await makeMock().ask({ model: 'mock-0', state: buildState(tabs), questions });

  assert.deepEqual(Object.keys(res.answers).sort(), Object.keys(questions).sort());
  assert.equal(parseAnswers(res).length, tabs.length * NOUL_FACETS.length);
});

test('mock is deterministic for the same tab', async () => {
  const tabs = [{ title: 'T', url: 'https://x.test/a' }];
  const q = buildQuestions([{ facets: NOUL_FACETS }]);
  const m = makeMock();
  const a = await m.ask({ state: buildState(tabs), questions: q });
  const b = await m.ask({ state: buildState(tabs), questions: q });
  assert.deepEqual(a.answers, b.answers);
});

test('mock nouls are probabilities', async () => {
  const tabs = Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, url: `https://x.test/${i}` }));
  const res = await makeMock().ask({
    state: buildState(tabs),
    questions: buildQuestions(tabs.map(() => ({ facets: NOUL_FACETS }))),
  });
  for (const [k, a] of Object.entries(res.answers)) {
    assert.ok(a.noul >= 0 && a.noul <= 1, `${k} = ${a.noul}`);
  }
});

test('mock leans disposable for a search results page', async () => {
  const tabs = [{ title: 'kittens - Google Search', url: 'https://www.google.com/search' }];
  const res = await makeMock().ask({
    state: buildState(tabs),
    questions: buildQuestions([{ facets: NOUL_FACETS }]),
  });
  assert.ok(res.answers.t0_disp.noul > 0.8, 'search results should look disposable');
  assert.ok(res.answers.t0_wip.noul < 0.2, 'and not like work in progress');
});

test('mock leans work-in-progress for an open PR', async () => {
  const tabs = [{ title: 'Add backoff by stahnma · Pull Request #12', url: 'https://github.com/foo/bar/pull/12' }];
  const res = await makeMock().ask({
    state: buildState(tabs),
    questions: buildQuestions([{ facets: NOUL_FACETS }]),
  });
  assert.ok(res.answers.t0_wip.noul > 0.8, 'an open PR should look like work in progress');
});
