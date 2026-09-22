// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withRetry, computeDelay, parseRetryAfter, isRetryableStatus, DEFAULT_POLICY } from '../src/transport/backoff.js';

const noSleep = async () => {};
const collect = () => { const d = []; return [d, async (ms) => { d.push(ms); }]; };

test('retryable statuses', () => {
  for (const s of [408, 429, 500, 502, 503, 529]) assert.ok(isRetryableStatus(s), String(s));
  for (const s of [200, 400, 401, 403, 404, 422]) assert.ok(!isRetryableStatus(s), String(s));
});

test('422 is not retried -- a malformed request will not fix itself', async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls++; return { status: 422 }; }, { sleep: noSleep });
  assert.equal(calls, 1);
  assert.equal(r.status, 422);
});

test('429 is retried up to maxRetries then returned', async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls++; return { status: 429 }; }, { sleep: noSleep, rand: () => 0 });
  assert.equal(calls, 3, 'initial attempt + 2 retries');
  assert.equal(r.status, 429);
  assert.equal(r.attempts, 3);
});

test('succeeds on a retry and reports the attempt count', async () => {
  let calls = 0;
  const r = await withRetry(async () => { calls++; return { status: calls < 3 ? 503 : 200, value: 'ok' }; },
    { sleep: noSleep, rand: () => 0 });
  assert.equal(r.status, 200);
  assert.equal(r.value, 'ok');
  assert.equal(r.attempts, 3);
});

test('a thrown connection error is retried, then rethrown', async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw new TypeError('Failed to fetch'); }, { sleep: noSleep, rand: () => 0 }),
    /Failed to fetch/);
  assert.equal(calls, 3);
});

test('backoff doubles and caps', () => {
  const p = { ...DEFAULT_POLICY, backoffJitter: 0 };
  assert.equal(computeDelay(0, p, undefined, 0), 500);
  assert.equal(computeDelay(1, p, undefined, 0), 1000);
  assert.equal(computeDelay(2, p, undefined, 0), 2000);
  assert.equal(computeDelay(9, p, undefined, 0), 5000, 'capped at backoffMaxMs');
});

test('jitter only ever subtracts', () => {
  for (const r of [0, 0.5, 0.999]) {
    const d = computeDelay(0, DEFAULT_POLICY, undefined, r);
    assert.ok(d <= 500 && d >= 375, `delay ${d} out of range`);
  }
});

test('Retry-After in seconds wins over computed backoff', async () => {
  const [delays, sleep] = collect();
  let calls = 0;
  await withRetry(async () => { calls++; return { status: 429, retryAfter: '2' }; }, { sleep, rand: () => 0 });
  assert.deepEqual(delays, [2000, 2000]);
});

test('Retry-After as an HTTP date is honored', () => {
  const now = Date.UTC(2026, 0, 1, 0, 0, 0);
  const ms = parseRetryAfter(new Date(now + 3000).toUTCString(), now);
  assert.ok(ms >= 2000 && ms <= 3000, `got ${ms}`);
});

test('an absurd Retry-After falls back to normal backoff', () => {
  const d = computeDelay(0, DEFAULT_POLICY, 999999999, 0);
  assert.equal(d, 500, 'beyond maxRetryAfterMs, ignore it');
});

test('parseRetryAfter tolerates junk', () => {
  assert.equal(parseRetryAfter(null), undefined);
  assert.equal(parseRetryAfter(''), undefined);
  assert.equal(parseRetryAfter('not-a-date'), undefined);
});
