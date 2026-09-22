// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrateSettings, defaultSettings, SCHEMA_VERSION } from '../src/core/schema.js';

test('no stored settings yields the current defaults', () => {
  const { settings, changed } = migrateSettings(null);
  assert.deepEqual(settings, defaultSettings());
  assert.deepEqual(changed, []);
});

test('a superseded default is replaced', () => {
  // The actual bug: saving settings once froze minAgeHours at 72 forever.
  const { settings, changed } = migrateSettings({ v: 1, minAgeHours: 72, chunkSize: 12 });
  assert.equal(settings.minAgeHours, 2);
  assert.equal(settings.chunkSize, 8);
  assert.ok(changed.includes('minAgeHours'));
});

test('a value the user deliberately chose is never overwritten', () => {
  const { settings, changed } = migrateSettings({ v: 1, minAgeHours: 100 });
  assert.equal(settings.minAgeHours, 100, 'not a known old default, so it is theirs');
  assert.ok(!changed.includes('minAgeHours'));
});

test('the interim 24h default is also superseded', () => {
  const { settings } = migrateSettings({ v: 2, minAgeHours: 24 });
  assert.equal(settings.minAgeHours, 2);
});

test('new keys arrive with their defaults', () => {
  const { settings } = migrateSettings({ v: 1, minAgeHours: 72 });
  assert.equal(settings.staleAfterDays, 14);
  assert.equal(settings.thresholds.dead, 0.7);
});

test('migration is idempotent', () => {
  const once = migrateSettings({ v: 1, minAgeHours: 72 }).settings;
  const twice = migrateSettings(once);
  assert.deepEqual(twice.settings, once);
  assert.deepEqual(twice.changed, [], 'a second pass changes nothing');
});

test('migration stamps the current version', () => {
  assert.equal(migrateSettings({ v: 1 }).settings.v, SCHEMA_VERSION);
});

test('unrelated stored settings survive', () => {
  const stored = { v: 1, minAgeHours: 72, denylist: ['internal.example.com'], shadowMode: false };
  const { settings } = migrateSettings(stored);
  assert.deepEqual(settings.denylist, ['internal.example.com']);
  assert.equal(settings.shadowMode, false);
});

test('the API key is not part of settings', () => {
  assert.ok(!('apiKey' in defaultSettings()), 'it lives under its own storage key');
});
