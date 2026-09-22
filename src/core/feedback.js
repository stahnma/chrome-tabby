// @ts-check
/**
 * Learning your policy, not the model's.
 *
 * Jev cannot be fine-tuned -- it is a fixed classifier. What CAN improve is the policy
 * laid over its judgments: which thresholds, and which sites you have ruled on directly.
 * Both come from labels, and every label is scored against stored judgments, so tuning
 * never costs an API call.
 */

import { evaluateGates } from './decide.js';
import { NOUL_FACETS } from './schema.js';

/**
 * One thing you told us. `verdict` is what SHOULD have happened, not what did.
 *
 * @typedef {object} Label
 * @property {string} id
 * @property {number} at
 * @property {string} evidenceHash
 * @property {string} url
 * @property {string} host
 * @property {string} title
 * @property {'close'|'keep'} verdict
 * @property {string} reason
 * @property {Record<string, number|string>} facets
 * @property {number} ageHours
 */

/** Reasons offered in the UI, and what each one means mechanically. */
export const REASONS = {
  missed:  { verdict: 'close', label: 'Should have closed',  hint: 'you closed it by hand' },
  needed:  { verdict: 'keep',  label: 'I still need this',   hint: 'it proposed a close and was wrong' },
  dead:    { verdict: 'close', label: 'Dead or expired',     hint: 'error page, 404, or logged out' },
  never:   { verdict: 'keep',  label: 'Never close this site', hint: 'adds the host to the denylist' },
  always:  { verdict: 'close', label: 'Always close this site', hint: 'closes this host without asking' },
};

/** @param {Label[]} labels @param {number} cap */
export function prune(labels, cap) {
  // One label per tab identity: the most recent thing you said wins.
  const seen = new Set();
  const out = [];
  for (const l of [...labels].sort((a, b) => b.at - a.at)) {
    const key = `${l.evidenceHash}:${l.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
    if (out.length >= cap) break;
  }
  return out;
}

const STEPS = Array.from({ length: 19 }, (_, i) => Number(((i + 1) * 0.05).toFixed(2)));

/**
 * How badly does one settings object disagree with your labels?
 *
 * Closing something you wanted is much worse than leaving something you would have
 * closed -- one destroys work, the other just leaves a tab open -- so a false close
 * costs more. PURE.
 *
 * @param {Label[]} labels
 * @param {import('./schema.js').Settings} settings
 * @param {number} [fpWeight]
 */
export function score(labels, settings, fpWeight = 3) {
  let agree = 0, falseClose = 0, falseKeep = 0;
  for (const l of labels) {
    const { action } = evaluateGates({
      facets: l.facets, ageHours: l.ageHours, host: l.host, settings,
    });
    if (action === l.verdict) agree++;
    else if (action === 'close') falseClose++;
    else falseKeep++;
  }
  return {
    agree, falseClose, falseKeep, total: labels.length,
    cost: falseClose * fpWeight + falseKeep,
    accuracy: labels.length ? agree / labels.length : 0,
  };
}

/**
 * Coordinate descent over the five thresholds.
 *
 * A full grid is 19^5; sweeping one axis at a time for a couple of passes finds a good
 * local optimum in a few thousand evaluations, and -- more usefully -- stays explainable:
 * every move is "this one threshold, from x to y, fixed n disagreements".
 *
 * PURE.
 *
 * @param {Label[]} labels
 * @param {import('./schema.js').Settings} settings
 * @param {number} [passes]
 */
export function sweepThresholds(labels, settings, passes = 2) {
  const current = score(labels, settings);
  if (labels.length < 5) {
    return { current, best: current, thresholds: settings.thresholds, moves: [], enoughData: false };
  }

  let best = { ...settings.thresholds };
  let bestScore = current;
  const moves = [];

  for (let pass = 0; pass < passes; pass++) {
    for (const facet of NOUL_FACETS) {
      let localBest = best[facet];
      let localScore = bestScore;
      for (const v of STEPS) {
        if (v === best[facet]) continue;
        const candidate = { ...best, [facet]: v };
        const s = score(labels, { ...settings, thresholds: candidate });
        // Strict improvement only, so ties never cause pointless churn.
        if (s.cost < localScore.cost) { localBest = v; localScore = s; }
      }
      if (localBest !== best[facet]) {
        moves.push({
          facet, from: best[facet], to: localBest,
          fixed: bestScore.cost - localScore.cost, pass: pass + 1,
        });
        best = { ...best, [facet]: localBest };
        bestScore = localScore;
      }
    }
  }

  return { current, best: bestScore, thresholds: best, moves, enoughData: true };
}

/**
 * What would change, right now, if the suggested thresholds were applied.
 * @param {import('./schema.js').Decision[]} items
 * @param {import('./schema.js').Settings} settings
 * @param {Record<string, number>} thresholds
 */
export function previewChange(items, settings, thresholds) {
  const next = { ...settings, thresholds };
  const flips = { toClose: [], toKeep: [] };
  for (const d of items) {
    if (!d.facets || typeof d.facets.wip !== 'number') continue;
    const before = d.action;
    const after = evaluateGates({
      facets: d.facets, ageHours: d.ageHours, host: '', settings: next,
    }).action;
    if (before === after) continue;
    (after === 'close' ? flips.toClose : flips.toKeep).push(d);
  }
  return flips;
}
