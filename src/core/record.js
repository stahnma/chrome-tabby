// @ts-check
/**
 * Turning a click into a label, and a label into a rule.
 *
 * Two kinds of feedback arrive here: explicit (you pressed a reason button) and implicit
 * (you closed something by hand, or restored something it closed). Implicit feedback is
 * the valuable kind -- it costs you nothing and you generate it just by using the thing.
 */

import { getFeedback, setFeedback, getSettings, patchSettings, getJudgments } from './storage.js';
import { prune, REASONS } from './feedback.js';
import { hostnameOf } from './url.js';

/**
 * @param {object} args
 * @param {string} args.evidenceHash
 * @param {string} args.url
 * @param {string} [args.title]
 * @param {number} [args.ageHours]
 * @param {keyof typeof REASONS} args.reason
 */
export async function recordFeedback({ evidenceHash, url, title = '', ageHours = 0, reason }) {
  const spec = REASONS[reason];
  if (!spec) throw new Error(`unknown reason: ${reason}`);

  const [settings, judgments, feedback] = await Promise.all([
    getSettings(), getJudgments(), getFeedback(),
  ]);

  const host = hostnameOf(url);
  const answers = judgments[evidenceHash]?.answers ?? {};
  /** @type {Record<string, number|string>} */
  const facets = {};
  for (const [f, a] of Object.entries(answers)) facets[f] = a.v;

  const label = {
    id: `fb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    evidenceHash, url, host, title, ageHours,
    verdict: spec.verdict, reason, facets,
  };

  await setFeedback(prune([label, ...feedback], settings.feedbackCap));

  // Two of the reasons are not really labels -- they are you stating a rule outright.
  // Those take effect immediately rather than waiting for a tuning pass.
  let ruleAdded = null;
  if (reason === 'never' && host && !settings.denylist.includes(host)) {
    await patchSettings({ denylist: [...settings.denylist, host] });
    ruleAdded = { list: 'denylist', host };
  }
  if (reason === 'always' && host && !(settings.alwaysCloseHosts ?? []).includes(host)) {
    await patchSettings({ alwaysCloseHosts: [...(settings.alwaysCloseHosts ?? []), host] });
    ruleAdded = { list: 'alwaysCloseHosts', host };
  }

  return { label, ruleAdded };
}

/**
 * Implicit label from an action rather than an opinion.
 *
 * Takes the decisions themselves rather than ids: the caller has already got them, and
 * re-reading the proposal here would race the caller pruning the closed rows out of it.
 *
 * @param {import('./schema.js').Decision[]} decisions
 * @param {'missed'|'needed'} reason
 */
export async function recordImplicit(decisions, reason) {
  let recorded = 0;
  for (const d of decisions) {
    if (!d?.evidenceHash) continue;
    // Only informative when it disagrees with what the system decided: closing something
    // it already wanted to close teaches nothing.
    if (reason === 'missed' && d.action === 'close') continue;
    await recordFeedback({
      evidenceHash: d.evidenceHash, url: d.url, title: d.title, ageHours: d.ageHours, reason,
    });
    recorded++;
  }
  return { recorded };
}
