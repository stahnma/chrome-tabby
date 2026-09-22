// @ts-check
/**
 * The rule engine. PURE: no chrome.*, no fetch, no Date.now().
 *
 * `now` is a parameter so "what would happen in five days" is a function call rather than
 * a waiting game, and so the whole thing unit-tests under `node --test` with zero mocking.
 *
 * Everything time-dependent lives here rather than in the model evidence -- that is what
 * keeps the judgment cache stable across nights.
 */

import { REQUIRED_FACETS } from './schema.js';
import { hostnameOf } from './url.js';

/** @typedef {import('./schema.js').TabFact & {evidenceHash: string}} HashedTab */

const HOUR_MS = 3600e3;

/** Schemes we will never touch. */
const CLOSEABLE_SCHEMES = new Set(['http:', 'https:']);

/**
 * Suffix match, on a label boundary so "notevil.com" doesn't match a "evil.com" entry.
 * @param {string} hostname
 * @param {string[]} denylist
 */
export function isDenied(hostname, denylist) {
  const h = hostname.toLowerCase();
  return denylist.some((raw) => {
    const d = raw.trim().toLowerCase().replace(/^\./, '');
    return d !== '' && (h === d || h.endsWith(`.${d}`));
  });
}

/**
 * An age *floor*. After a session restore, `lastAccessed` on a restored-but-never-activated
 * tab can reflect the restore rather than real use, making a months-old tab look fresh.
 * `firstSeen` comes free with the judgment cache, so the earlier of the two is a safe
 * lower bound on how long this tab has really been sitting there.
 *
 * @param {HashedTab} tab
 * @param {import('./schema.js').Judgment|undefined} judgment
 * @param {number} now
 */
export function ageHoursOf(tab, judgment, now) {
  const seen = judgment?.firstSeen ?? Infinity;
  const effective = Math.min(tab.lastAccessed ?? now, seen);
  return Math.max(0, (now - effective) / HOUR_MS);
}

/**
 * Reasons a tab is untouchable regardless of what the model thinks.
 * Deliberately not user-configurable.
 * @param {HashedTab} tab
 * @param {import('./schema.js').Settings} settings
 * @returns {import('./schema.js').Reason|null}
 */
function hardSkip(tab, settings) {
  if (tab.pinned) return { code: 'PINNED', detail: 'pinned tabs are never closed' };
  if (tab.audible) return { code: 'AUDIBLE', detail: 'currently playing audio' };
  if (tab.active) return { code: 'ACTIVE', detail: 'active tab in its window' };
  if (tab.windowTabCount <= 1) {
    return { code: 'LAST_IN_WINDOW', detail: 'closing it would close the window' };
  }

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return { code: 'BAD_URL', detail: `unparseable url: ${tab.url}` };
  }
  if (!CLOSEABLE_SCHEMES.has(url.protocol)) {
    return { code: 'SCHEME', detail: `${url.protocol} is out of scope` };
  }
  if (isDenied(url.hostname, settings.denylist)) {
    return { code: 'DENYLIST', detail: `${url.hostname} is on the denylist` };
  }
  const limit = settings.debug?.limitToWindowId;
  if (limit != null && tab.windowId !== limit) {
    return { code: 'WINDOW_LIMIT', detail: `debug limit to window ${limit}` };
  }
  return null;
}

/**
 * @param {import('./schema.js').Judgment|undefined} judgment
 * @param {string} facet
 * @returns {number|undefined}
 */
function noul(judgment, facet) {
  const v = judgment?.answers?.[facet]?.v;
  return typeof v === 'number' ? v : undefined;
}

/**
 * @param {object} input
 * @param {HashedTab[]} input.tabs
 * @param {Record<string, import('./schema.js').Judgment>} input.judgments
 * @param {import('./schema.js').Settings} input.settings
 * @param {number} input.now
 * @returns {import('./schema.js').DecisionSet}
 */
/**
 * The gate cascade, over nothing but facet values, age and settings.
 *
 * Split out of decide() so the threshold tuner can score candidate settings against past
 * labels using the exact same logic. If these ever diverge, the tuner starts recommending
 * settings that behave differently in the real run.
 *
 * PURE.
 *
 * @param {object} args
 * @param {Record<string, number|string>} args.facets
 * @param {number} args.ageHours
 * @param {string} [args.host]
 * @param {import('./schema.js').Settings} args.settings
 * @returns {{action:'close'|'keep', reasons:import('./schema.js').Reason[]}}
 */
export function evaluateGates({ facets, ageHours, host = '', settings }) {
  const t = settings.thresholds;
  const num = (f) => (typeof facets[f] === 'number' ? /** @type {number} */ (facets[f]) : undefined);
  const close = (...reasons) => ({ action: /** @type {'close'} */ ('close'), reasons });
  const keep = (code, detail) => ({ action: /** @type {'keep'} */ ('keep'), reasons: [{ code, detail }] });

  const missing = REQUIRED_FACETS.filter((f) => num(f) === undefined);
  if (missing.length > 0) return keep('FACETS_MISSING', `no judgment yet for: ${missing.join(', ')}`);

  if (ageHours < settings.minAgeHours) {
    return keep('TOO_RECENT', `${ageHours.toFixed(1)}h old < ${settings.minAgeHours}h minimum`);
  }

  // An explicit "always close this site" rule outranks every model judgment below it --
  // you told us directly, so there is nothing left to infer.
  if (host && isDenied(host, settings.alwaysCloseHosts ?? [])) {
    return close({ code: 'ALWAYS_CLOSE_HOST', detail: `${host} is on your always-close list` });
  }

  // A page showing an error or a sign-in wall has no content to protect, so this runs
  // ahead of the soft vetoes and overrides them: a dead page cannot be work in progress
  // and cannot be saved reading, whatever its address makes it look like.
  const dead = num('dead');
  if (dead !== undefined && dead >= t.dead) {
    return close(
      { code: 'AGE_OK', detail: `${ageHours.toFixed(1)}h old` },
      { code: 'DEAD', detail: `error or sign-in wall ${dead.toFixed(2)} >= ${t.dead}` });
  }

  // Independent gates, never a weighted sum: arithmetic across separate questions is
  // not meaningful (a noul and its negation do not sum to 1), and a failed gate names
  // itself in the review UI.
  const wip = /** @type {number} */ (num('wip'));
  if (wip >= t.wip) return keep('WIP', `wip ${wip.toFixed(2)} >= ${t.wip}`);

  const saved = /** @type {number} */ (num('savedForLater'));
  if (saved >= t.savedForLater) {
    return keep('SAVED_FOR_LATER', `savedForLater ${saved.toFixed(2)} >= ${t.savedForLater}`);
  }

  const staleHours = (settings.staleAfterDays ?? 0) * 24;
  const veryStale = staleHours > 0 && ageHours >= staleHours;

  const disposable = /** @type {number} */ (num('disposable'));
  const retrievable = /** @type {number} */ (num('retrievable'));
  if (!veryStale && !(disposable >= t.disposable || retrievable >= t.retrievable)) {
    return keep('NOT_DISPOSABLE_OR_RETRIEVABLE',
      `disposable ${disposable.toFixed(2)} < ${t.disposable} and retrievable ${retrievable.toFixed(2)} < ${t.retrievable}, and not yet ${settings.staleAfterDays}d old`);
  }

  const category = facets.category;
  if (typeof category === 'string' && settings.protectedCategories.includes(category)) {
    return keep('PROTECTED_CATEGORY', `category ${category} is protected`);
  }

  return close(
    { code: 'AGE_OK', detail: `${ageHours.toFixed(1)}h old` },
    { code: 'WIP_LOW', detail: `wip ${wip.toFixed(2)} < ${t.wip}` },
    { code: 'SAVED_LOW', detail: `savedForLater ${saved.toFixed(2)} < ${t.savedForLater}` },
    disposable >= t.disposable
      ? { code: 'DISPOSABLE', detail: `disposable ${disposable.toFixed(2)} >= ${t.disposable}` }
      : retrievable >= t.retrievable
        ? { code: 'RETRIEVABLE', detail: `retrievable ${retrievable.toFixed(2)} >= ${t.retrievable}` }
        : { code: 'VERY_STALE', detail: `untouched ${Math.round(ageHours / 24)}d, past the ${settings.staleAfterDays}d mark` });
}

export function decide({ tabs, judgments, settings, now }) {

  /** @type {import('./schema.js').Decision[]} */
  const items = tabs.map((tab) => {
    const judgment = judgments[tab.evidenceHash];
    const ageHours = ageHoursOf(tab, judgment, now);

    /** @type {Record<string, number|string>} */
    const facets = {};
    for (const [f, a] of Object.entries(judgment?.answers ?? {})) facets[f] = a.v;

    /** @param {import('./schema.js').Reason} reason */
    const keep = (reason) => ({
      tabId: tab.tabId,
      windowId: tab.windowId,
      evidenceHash: tab.evidenceHash,
      title: tab.title,
      url: tab.url,
      ageHours,
      facets,
      action: /** @type {'keep'} */ ('keep'),
      reasons: [reason],
    });

    const skip = hardSkip(tab, settings);
    if (skip) return keep(skip);

    const gated = evaluateGates({ facets, ageHours, host: hostnameOf(tab.url), settings });
    if (gated.action === 'keep') return keep(gated.reasons[0]);
    return {
      tabId: tab.tabId, windowId: tab.windowId, evidenceHash: tab.evidenceHash,
      title: tab.title, url: tab.url, ageHours, facets,
      action: /** @type {'close'} */ ('close'),
      reasons: gated.reasons,
    };
  });

  // Cap the blast radius. Oldest first, so the cap defers the marginal cases to tomorrow.
  const closers = items.filter((d) => d.action === 'close').sort((a, b) => b.ageHours - a.ageHours);
  for (const d of closers.slice(settings.maxClosesPerRun)) {
    d.action = 'keep';
    d.reasons = [{ code: 'CAP_REACHED', detail: `over maxClosesPerRun (${settings.maxClosesPerRun})` }];
  }

  const closeCount = items.filter((d) => d.action === 'close').length;
  return { items, closeCount, keepCount: items.length - closeCount };
}
