// @ts-check
/**
 * Storage keys, defaults, and the shared type vocabulary.
 * Every other module depends on the shapes in here.
 */

/** Top-level keys in chrome.storage.local. Flat, so reads and writes stay narrow. */
export const K = /** @type {const} */ ({
  SCHEMA: 'schemaVersion',
  SETTINGS: 'settings',
  API_KEY: 'apiKey', // its own key, so settings can be dumped or logged without leaking it
  JUDGMENTS: 'judgments',
  PROPOSAL: 'proposal',
  ARCHIVE: 'archive',
  RUN_STATE: 'runState',
  RUN_LOG: 'runLog',
  FEEDBACK: 'feedback',
});

export const SCHEMA_VERSION = 4;

/** The noul facets. Order is display order. */
export const NOUL_FACETS = /** @type {const} */ (['wip', 'disposable', 'retrievable', 'savedForLater', 'dead']);

/** Facets that must be present before any tab is eligible to close. */
/**
 * Two different lists, and conflating them is a silent failure:
 *
 * - ASK_FACETS is what every run requests. Everything the decision can use belongs here.
 * - REQUIRED_FACETS is what must already be present before a tab can be judged at all.
 *   `dead` is deliberately absent so a judgment cached before it existed still decides
 *   instead of stalling on FACETS_MISSING.
 */
export const ASK_FACETS = NOUL_FACETS;
export const REQUIRED_FACETS = /** @type {const} */ (['wip', 'disposable', 'retrievable', 'savedForLater']);

export const CATEGORIES = /** @type {const} */ ([
  'search_results',
  'social_feed',
  'video_or_media',
  'documentation_or_reference',
  'article_or_blog',
  'code_host_or_ticket',
  'cloud_console_or_admin',
  'webmail_or_chat',
  'shopping_or_checkout',
  'local_dev_server',
  'auth_or_redirect',
  'dashboard_or_settings',
  'other',
]);

/**
 * @typedef {'wip'|'disposable'|'retrievable'|'savedForLater'|'dead'} NoulFacet
 * @typedef {NoulFacet|'category'} Facet
 */

/**
 * A tab as we see it locally. `url` is already sanitized (origin + path).
 * @typedef {object} TabFact
 * @property {number} tabId          Session-scoped. Never persisted as identity.
 * @property {number} windowId
 * @property {string} title
 * @property {string} url            Sanitized: no query, no fragment.
 * @property {string} [favIconUrl]
 * @property {number} lastAccessed   ms epoch
 * @property {boolean} pinned
 * @property {boolean} audible
 * @property {boolean} active
 * @property {number} windowTabCount Used for the only-tab-in-window skip.
 * @property {string} [groupTitle]
 */

/**
 * One cached answer. `qh` is a hash of the instruction text that produced it,
 * `m` the model id -- either changing invalidates just this facet.
 * @typedef {object} CachedAnswer
 * @property {number|string} v
 * @property {string} qh
 * @property {string} m
 * @property {number} at
 */

/**
 * @typedef {object} Judgment
 * @property {string} url
 * @property {string} title
 * @property {number} firstSeen   Doubles as an age floor -- see decide().
 * @property {number} lastSeen    Drives pruning.
 * @property {Record<string, CachedAnswer>} answers
 */

/**
 * @typedef {object} Reason
 * @property {string} code
 * @property {string} detail
 */

/**
 * @typedef {object} Decision
 * @property {number} tabId
 * @property {number} windowId
 * @property {string} evidenceHash
 * @property {string} title
 * @property {string} url
 * @property {number} ageHours
 * @property {Record<string, number|string>} facets  raw judgment values, for review and charting
 * @property {'close'|'keep'} action
 * @property {Reason[]} reasons
 */

/**
 * @typedef {object} DecisionSet
 * @property {Decision[]} items
 * @property {number} closeCount
 * @property {number} keepCount
 */

/** @returns {import('./schema.js').Settings} */
export function defaultSettings() {
  return {
    v: SCHEMA_VERSION,
    shadowMode: true, // default ON. Flipping it off is gated on hasVerifiedRestore.
    model: 'jev-1.13.0', // pinned. 'jev-latest' would silently invalidate tuned thresholds.
    transport: { mode: 'mock', proxyUrl: '' }, // start offline+free; switch to 'direct' once a key is saved
    schedule: { hour: 3, minute: 30 },
    catchUp: { shadowMaxLateHours: 24, liveMaxLateHours: 6 },
    chunkSize: 8, // measured: ~23k tok at 4 nouls. Raise once a real run reports usage.
    minAgeHours: 2,
    staleAfterDays: 14, // past this, age alone justifies a close. 0 disables.
    maxClosesPerRun: 25,
    thresholds: { wip: 0.25, disposable: 0.7, retrievable: 0.85, savedForLater: 0.6, dead: 0.7 },
    protectedCategories: ['code_host_or_ticket', 'cloud_console_or_admin', 'local_dev_server'],
    denylist: ['mail.google.com', 'calendar.google.com', 'localhost', '127.0.0.1'],
    alwaysCloseHosts: [], // you said so directly; outranks every model judgment
    feedbackCap: 2000,
    archiveCap: 5000,
    archiveMaxDays: 180,
    judgmentMaxIdleDays: 45,
    hasVerifiedRestore: false,
    debug: { nowOffsetHours: 0, limitToWindowId: null },
  };
}

/**
 * Bring a stored settings object up to the current version.
 *
 * Stored settings override defaults, so once anything is saved the whole object is frozen
 * and later default changes never reach the user. Each version bump names exactly which
 * fields to re-apply, and only touches a field if it still holds the old default -- a
 * value the user deliberately chose is never overwritten.
 *
 * PURE.
 *
 * @param {any} stored
 * @returns {{settings:any, changed:string[]}}
 */
export function migrateSettings(stored) {
  if (!stored) return { settings: defaultSettings(), changed: [] };

  const s = { ...defaultSettings(), ...stored };
  const changed = [];
  const from = stored.v ?? 1;

  /** Replace only if it still holds the superseded default. */
  const bump = (key, oldDefault, newValue) => {
    if (s[key] === oldDefault) { s[key] = newValue; changed.push(key); }
  };

  if (from < 2) {
    bump('minAgeHours', 72, 2);          // 72h could never fire on a daily cleanup
    if (stored.staleAfterDays === undefined) { s.staleAfterDays = 14; changed.push('staleAfterDays'); }
    bump('chunkSize', 12, 8);
  }
  if (from < 4) {
    if (stored.alwaysCloseHosts === undefined) { s.alwaysCloseHosts = []; changed.push('alwaysCloseHosts'); }
  }
  if (from < 3) {
    bump('minAgeHours', 24, 2);          // interim default, also too slow
    if (stored.thresholds && stored.thresholds.dead === undefined) {
      s.thresholds = { ...s.thresholds, dead: defaultSettings().thresholds.dead };
      changed.push('thresholds.dead');
    }
  }

  s.v = SCHEMA_VERSION;
  return { settings: s, changed };
}

/**
 * @typedef {object} Settings
 * @property {number} v
 * @property {boolean} shadowMode
 * @property {string} model
 * @property {{mode:'direct'|'proxy'|'mock', proxyUrl:string}} transport
 * @property {{hour:number, minute:number}} schedule
 * @property {{shadowMaxLateHours:number, liveMaxLateHours:number}} catchUp
 * @property {number} chunkSize
 * @property {number} minAgeHours
 * @property {number} staleAfterDays
 * @property {number} maxClosesPerRun
 * @property {Record<NoulFacet, number>} thresholds
 * @property {string[]} protectedCategories
 * @property {string[]} denylist
 * @property {string[]} alwaysCloseHosts
 * @property {number} feedbackCap
 * @property {number} archiveCap
 * @property {number} archiveMaxDays
 * @property {number} judgmentMaxIdleDays
 * @property {boolean} hasVerifiedRestore
 * @property {{nowOffsetHours:number, limitToWindowId:number|null}} debug
 */
