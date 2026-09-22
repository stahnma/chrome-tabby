// @ts-check
/**
 * The only module that touches chrome.storage.
 *
 * Everything lives in `local`, never `sync` -- sync would plaintext-replicate the API key
 * to every signed-in Chrome. Keys are flat and separate so reads and writes stay narrow.
 *
 * Only the service worker writes `judgments` and `archive`: read-modify-write is not
 * atomic, and the run machine is single-flight. UI pages go through sendMessage.
 */

import { K, SCHEMA_VERSION, defaultSettings, migrateSettings } from './schema.js';

/** @param {string} key @param {any} fallback */
async function get(key, fallback) {
  const got = await chrome.storage.local.get(key);
  return got[key] ?? fallback;
}

/** @param {string} key @param {any} value */
async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

/**
 * @returns {Promise<import('./schema.js').Settings>}
 *
 * Runs the migration on every read and writes back when it changes something, so a
 * superseded default can never sit frozen in storage.
 */
export async function getSettings() {
  const stored = await get(K.SETTINGS, null);
  const { settings, changed } = migrateSettings(stored);
  if (stored && changed.length) {
    await set(K.SETTINGS, settings);
    console.info('[tabby] migrated settings:', changed.join(', '));
  }
  return settings;
}

/** Throw away stored settings and start from the current defaults. */
export async function resetSettings() {
  const fresh = defaultSettings();
  await set(K.SETTINGS, fresh);
  return fresh;
}

/**
 * @param {Partial<import('./schema.js').Settings>} patch
 * Callers that change `schedule` should re-arm the alarm afterwards; background.js does.
 */
export async function patchSettings(patch) {
  const prev = await getSettings();
  const next = { ...prev, ...patch };
  await set(K.SETTINGS, next);
  next._scheduleChanged =
    prev.schedule.hour !== next.schedule.hour || prev.schedule.minute !== next.schedule.minute;
  return next;
}

export const getApiKey = () => get(K.API_KEY, '');
/** @param {string} k */
export const setApiKey = (k) => set(K.API_KEY, k);

/** @returns {Promise<Record<string, import('./schema.js').Judgment>>} */
export const getJudgments = () => get(K.JUDGMENTS, {});

/** @param {Record<string, import('./schema.js').Judgment>} updates */
export async function mergeJudgments(updates) {
  const all = await getJudgments();
  for (const [hash, j] of Object.entries(updates)) {
    const prev = all[hash];
    all[hash] = prev
      ? { ...prev, ...j, firstSeen: Math.min(prev.firstSeen, j.firstSeen), answers: { ...prev.answers, ...j.answers } }
      : j;
  }
  await set(K.JUDGMENTS, all);
  return all;
}

/** Drop judgments untouched for longer than the configured idle window. */
export async function pruneJudgments(maxIdleDays, now = Date.now()) {
  const all = await getJudgments();
  const cutoff = now - maxIdleDays * 864e5;
  let dropped = 0;
  for (const [hash, j] of Object.entries(all)) {
    if ((j.lastSeen ?? 0) < cutoff) { delete all[hash]; dropped++; }
  }
  if (dropped) await set(K.JUDGMENTS, all);
  return dropped;
}

export const getProposal = () => get(K.PROPOSAL, null);
/** @param {any} p */
export const setProposal = (p) => set(K.PROPOSAL, p);

export const getRunState = () => get(K.RUN_STATE, { phase: 'idle', runId: null, lastTickAt: 0, lastCompletedDayKey: null, attempts: 0 });
/** @param {any} s */
export const setRunState = (s) => set(K.RUN_STATE, { ...s, lastTickAt: Date.now() });

export const getArchive = () => get(K.ARCHIVE, []);
/** @param {any[]} a */
export const setArchive = (a) => set(K.ARCHIVE, a);

export const getFeedback = () => get(K.FEEDBACK, []);
/** @param {any[]} f */
export const setFeedback = (f) => set(K.FEEDBACK, f);

export const getRunLog = () => get(K.RUN_LOG, []);
/** @param {any} entry @param {number} cap */
export async function pushRunLog(entry, cap = 60) {
  const log = [entry, ...(await getRunLog())].slice(0, cap);
  await set(K.RUN_LOG, log);
  return log;
}

export async function ensureSchema() {
  const v = await get(K.SCHEMA, null);
  if (v === null) await set(K.SCHEMA, SCHEMA_VERSION);
  // No migrations yet; when there are, they branch on v here.
}

/** Dev affordance -- dump one key, or everything. */
export async function dump(key) {
  return key ? await get(key, null) : await chrome.storage.local.get(null);
}
