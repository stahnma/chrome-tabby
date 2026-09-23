// @ts-check
/**
 * Deterministic fake answers, seeded by the tab's own url+facet.
 *
 * Purpose: run the entire pipeline -- chunking, caching, deciding, proposing -- offline,
 * repeatably, and for free. Same tab always gets the same answer, so cache-hit behavior
 * and threshold tuning can be exercised without spending a request.
 *
 * Nudged by a few keywords so a fixture set looks plausible rather than uniformly random.
 */

import { parseAnswers } from '../core/questions.js';
import { CATEGORIES } from '../core/schema.js';

/** FNV-1a, then a couple of xorshifts. Good enough for repeatable fixtures. */
function seeded(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h << 13; h >>>= 0;
  h ^= h >> 17;
  h ^= h << 5; h >>>= 0;
  return h / 0x100000000;
}

/** Aliases the real service resolves to a concrete version id. */
const ALIASES = new Set(['jev-latest', 'jev-preview']);

/** @type {[RegExp, Record<string, number>][]} */
const HINTS = [
  [/\/search\b|[?&]q=|duckduckgo|www\.google\.com\/search/i, { disposable: 0.93, savedForLater: 0.05, wip: 0.03 }],
  [/news\.ycombinator|reddit\.com|twitter\.com|x\.com|bsky/i, { disposable: 0.85, savedForLater: 0.15 }],
  [/github\.com\/[^/]+\/[^/]+\/(pull|issues)\//i, { wip: 0.88, disposable: 0.05, retrievable: 0.9 }],
  [/developer\.chrome\.com|docs\.|\/docs\/|mdn|readthedocs/i, { savedForLater: 0.78, retrievable: 0.95, disposable: 0.08 }],
  [/youtube\.com\/watch|vimeo/i, { disposable: 0.8, retrievable: 0.9 }],
  [/localhost|127\.0\.0\.1/i, { wip: 0.9, retrievable: 0.2 }],
  [/not found|404|sign in|log in|login|session expired/i, { dead: 0.94, wip: 0.05, disposable: 0.9 }],
];

function valueFor(url, title, facet) {
  const base = seeded(`${url}::${facet}`);
  for (const [re, over] of HINTS) {
    if (re.test(url) || re.test(title)) {
      if (facet in over) {
        // keep it deterministic but not a flat constant
        return Math.min(0.99, Math.max(0.01, over[facet] + (base - 0.5) * 0.08));
      }
    }
  }
  return Number(base.toFixed(3));
}

/** @returns {import('./index.js').Transport} */
export function makeMock() {
  return {
    async ask(req) {
      const tabs = req.state?.tabs ?? [];
      /** @type {Record<string, any>} */
      const answers = {};

      for (const key of Object.keys(req.questions ?? {})) {
        const m = /^t(\d+)_([a-z]+)$/.exec(key);
        if (!m) continue;
        const tab = tabs[Number(m[1])] ?? { url: '', title: '' };
        const isChoice = m[2] === 'cat';

        if (isChoice) {
          const r = seeded(`${tab.url}::category`);
          const choice = CATEGORIES[Math.floor(r * CATEGORIES.length)];
          answers[key] = { type: 'choice', choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 };
        } else {
          // map slug back through the shared parser's vocabulary
          const facet = { wip: 'wip', disp: 'disposable', retr: 'retrievable', save: 'savedForLater', dead: 'dead' }[m[2]];
          if (!facet) continue;
          answers[key] = { type: 'noul', noul: Number(valueFor(tab.url, tab.title ?? '', facet).toFixed(3)) };
        }
      }

      return {
        // Mirror the real API: an alias resolves to a concrete version in the response,
        // and anything else is echoed back. The judgment cache keys on this.
        model: ALIASES.has(req.model) ? 'mock-1.0.0' : (req.model ?? 'mock-1.0.0'),
        answers,
        usage: { input_tokens: JSON.stringify(req).length / 4 | 0, output_tokens: 0 },
      };
    },
  };
}

export { parseAnswers };
