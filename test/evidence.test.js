// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evidenceOf, evidenceHash } from '../src/core/evidence.js';
import { sanitizeUrl, hostnameOf, looksOpaque } from '../src/core/url.js';

test('sanitizeUrl drops query strings', () => {
  assert.equal(sanitizeUrl('https://example.com/search?q=secret'), 'https://example.com/search');
});

test('sanitizeUrl drops fragments', () => {
  assert.equal(sanitizeUrl('https://example.com/doc#section-3'), 'https://example.com/doc');
});

test('sanitizeUrl drops both, including tokens people would hate to leak', () => {
  const raw = 'https://internal.example.com/dashboard?token=abc123&user=michaels#tab=billing';
  assert.equal(sanitizeUrl(raw), 'https://internal.example.com/dashboard');
});

test('sanitizeUrl keeps the path, which is the part that carries meaning', () => {
  assert.equal(
    sanitizeUrl('https://github.com/foo/bar/pull/12?diff=split'),
    'https://github.com/foo/bar/pull/12');
});

test('sanitizeUrl normalizes a trailing slash', () => {
  assert.equal(sanitizeUrl('https://example.com/docs/'), sanitizeUrl('https://example.com/docs'));
});

test('sanitizeUrl leaves a bare root alone', () => {
  assert.equal(sanitizeUrl('https://example.com/'), 'https://example.com/');
});

test('sanitizeUrl preserves port and strips credentials', () => {
  assert.equal(sanitizeUrl('https://u:p@example.com:8443/x?y=1'), 'https://example.com:8443/x');
});

test('sanitizeUrl returns empty for garbage', () => {
  assert.equal(sanitizeUrl('not a url'), '');
  assert.equal(sanitizeUrl(''), '');
});

test('sanitizeUrl keeps non-http schemes recognizable for hard skips', () => {
  assert.match(sanitizeUrl('chrome://extensions'), /^chrome:/);
});

test('hostnameOf extracts the host', () => {
  assert.equal(hostnameOf('https://mail.google.com/u/0'), 'mail.google.com');
  assert.equal(hostnameOf('garbage'), '');
});

test('evidence carries only title and url', () => {
  const e = evidenceOf({ title: 'T', url: 'https://x.test/a', lastAccessed: 123, pinned: true });
  assert.deepEqual(Object.keys(e).sort(), ['title', 'url']);
});

test('evidence hash is stable across runs', async () => {
  const t = { title: 'A page', url: 'https://x.test/a' };
  assert.equal(await evidenceHash(t), await evidenceHash({ ...t }));
});

test('evidence hash ignores volatile tab state', async () => {
  // This is the property that makes the cache worth having: the same tab, a day later,
  // with a different lastAccessed, must hash the same or we re-pay for inference nightly.
  const base = { title: 'A page', url: 'https://x.test/a' };
  const a = await evidenceHash({ ...base, lastAccessed: 1, pinned: false, audible: false });
  const b = await evidenceHash({ ...base, lastAccessed: 999999, pinned: true, audible: true });
  assert.equal(a, b);
});

test('evidence hash changes when the title changes', async () => {
  const a = await evidenceHash({ title: 'A', url: 'https://x.test/a' });
  const b = await evidenceHash({ title: 'B', url: 'https://x.test/a' });
  assert.notEqual(a, b);
});

test('evidence hash tolerates a missing title', async () => {
  assert.equal(typeof await evidenceHash({ url: 'https://x.test/a' }), 'string');
});

test('evidence hash is 16 hex chars', async () => {
  assert.match(await evidenceHash({ title: 'T', url: 'https://x.test/a' }), /^[0-9a-f]{16}$/);
});

// Paths leak too. A one-time Fly CLI auth link puts the secret in the path, so stripping
// only the query string let it through -- found in a real proposal.
test('redacts a one-time auth token embedded in the path', () => {
  const raw = 'https://fly.io/app/auth/cli/7561633278613377716b747374616462756d6e357666693267735736333673';
  const out = sanitizeUrl(raw);
  assert.ok(!out.includes('756163'), 'the token must not survive');
  assert.equal(out, 'https://fly.io/app/auth/cli/…', 'but the shape stays legible');
});

test('redacts UUID path segments', () => {
  assert.equal(
    sanitizeUrl('https://claude.ai/code/artifact/485f33ed-24a4-475a-999f-77ed978d5746'),
    'https://claude.ai/code/artifact/…');
});

test('redacts long opaque ids', () => {
  assert.equal(sanitizeUrl('https://claude.ai/artifact/PtoWRXBeasvK7YkVD97rxx'),
    'https://claude.ai/artifact/…');
});

test('keeps readable slugs, which is where the meaning lives', () => {
  for (const [raw, want] of [
    ['https://github.com/superfly/sbd/pull/397/changes', 'https://github.com/superfly/sbd/pull/397/changes'],
    ['https://tangled.org/stahnma.us/snippets/issues/18', 'https://tangled.org/stahnma.us/snippets/issues/18'],
    ['https://www.amazon.com/smart-wagon', 'https://www.amazon.com/smart-wagon'],
    ['https://example.com/add-deterministic-checkpoint-workload-profiles', 'https://example.com/add-deterministic-checkpoint-workload-profiles'],
    ['https://developer.chrome.com/docs/extensions/reference/api/alarms', 'https://developer.chrome.com/docs/extensions/reference/api/alarms'],
  ]) {
    assert.equal(sanitizeUrl(raw), want, raw);
  }
});

test('looksOpaque draws the line where expected', () => {
  for (const s of ['7561633278613377716b747374616462756d6e35766669', 'PtoWRXBeasvK7YkVD97rxx',
                   '485f33ed-24a4-475a-999f-77ed978d5746']) {
    assert.ok(looksOpaque(s), s);
  }
  for (const s of ['pull', '397', 'changes', 'smart-wagon', 'alarms', '3mtoohu2ke522',
                   'add-deterministic-checkpoint-workload-profiles']) {
    assert.ok(!looksOpaque(s), s);
  }
});
