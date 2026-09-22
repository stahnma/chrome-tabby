// @ts-check
/**
 * Acting on a DecisionSet.
 *
 * Shadow stages a proposal and stops. Live archives first, then closes -- never the other
 * way round, and a failed archive write aborts that close.
 */

import { setProposal, getProposal as getProposalForClose, getJudgments } from './storage.js';
import { archiveEntry, addToArchive } from './archive.js';
import { stillUntouched } from './tabs.js';
import { sanitizeUrl } from './url.js';

/** @param {number} n */
async function setBadge(n) {
  try {
    await chrome.action.setBadgeText({ text: n > 0 ? String(n) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
  } catch { /* badge is cosmetic */ }
}

/**
 * @param {object} args
 * @param {import('./schema.js').DecisionSet} args.decisions
 * @param {import('./schema.js').Settings} args.settings
 * @param {any[]} args.tabs
 * @param {string} args.runId
 */
export async function execute({ decisions, settings, tabs, runId }) {
  const closers = decisions.items.filter((d) => d.action === 'close');

  if (settings.shadowMode) {
    await setProposal({
      runId,
      createdAt: Date.now(),
      mode: 'shadow',
      settingsSnapshot: {
        model: settings.model,
        thresholds: settings.thresholds,
        minAgeHours: settings.minAgeHours,
        maxClosesPerRun: settings.maxClosesPerRun,
      },
      items: decisions.items,
      reviewed: false,
    });
    await setBadge(closers.length);
    return { mode: 'shadow', staged: closers.length, closed: 0, skipped: 0 };
  }

  const judgments = await getJudgments();
  const byId = new Map(tabs.map((t) => [t.tabId, t]));
  const toClose = [];
  const entries = [];
  let skipped = 0;

  for (const d of closers) {
    const tab = byId.get(d.tabId);
    if (!tab) { skipped++; continue; }
    // You may have touched this tab while the run was in flight.
    if (!(await stillUntouched(d.tabId, tab.lastAccessed))) { skipped++; continue; }
    entries.push(archiveEntry(d, tab, runId, judgments[d.evidenceHash]?.answers ?? {}, 'auto'));
    toClose.push(d.tabId);
  }

  if (entries.length) await addToArchive(entries); // archive BEFORE closing
  if (toClose.length) {
    try {
      await chrome.tabs.remove(toClose);
    } catch (e) {
      return { mode: 'live', staged: closers.length, closed: 0, skipped, error: String(e) };
    }
  }

  await setProposal({
    runId, createdAt: Date.now(), mode: 'live',
    settingsSnapshot: { model: settings.model, thresholds: settings.thresholds },
    items: decisions.items, reviewed: true,
  });
  await setBadge(0);
  return { mode: 'live', staged: closers.length, closed: toClose.length, skipped };
}

/**
 * Close specific tabs on demand, from the review page or the popup.
 *
 * Same contract as a live run -- archive first, abort that tab's close if the archive
 * write fails -- but driven by a click rather than the threshold, and with no cap: this
 * is an explicit instruction, not an automated judgment.
 *
 * @param {number[]} tabIds
 */
export async function closeTabs(tabIds) {
  const proposal = await getProposalForClose();
  const judgments = await getJudgments();
  const byId = new Map((proposal?.items ?? []).map((d) => [d.tabId, d]));

  // tab.id is session-scoped: a browser restart renumbers every tab, so a proposal staged
  // before the restart holds ids that no longer resolve. The sanitized URL is the durable
  // identity, so fall back to it rather than silently doing nothing.
  const live = await chrome.tabs.query({});
  const byUrl = new Map();
  for (const t of live) {
    const u = sanitizeUrl(t.url ?? '');
    if (u && !byUrl.has(u)) byUrl.set(u, t);
  }

  const entries = [];
  const ids = [];
  const missing = [];
  const closedDecisions = [];

  for (const tabId of tabIds) {
    const d = byId.get(tabId);
    let tab = null;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      tab = d ? byUrl.get(d.url) ?? null : null;
    }
    if (!tab || tab.id === undefined) { missing.push(tabId); continue; }

    const decision = d ?? {
      tabId: tab.id, windowId: tab.windowId, evidenceHash: '', title: tab.title ?? '',
      url: sanitizeUrl(tab.url ?? ''), ageHours: 0, facets: {}, action: 'close', reasons: [],
    };
    entries.push(archiveEntry(decision, tab, proposal?.runId ?? 'manual',
      judgments[decision.evidenceHash]?.answers ?? {}, 'manual'));
    closedDecisions.push(decision);
    ids.push(tab.id);
  }

  if (entries.length) await addToArchive(entries); // archive BEFORE closing
  if (ids.length) await chrome.tabs.remove(ids);

  // Drop them from the staged proposal so the UI does not offer them again -- including
  // the ones that were already gone, which are equally not worth showing.
  if (proposal) {
    const done = new Set([...tabIds]);
    proposal.items = proposal.items.filter((d) => !done.has(d.tabId));
    await setProposal(proposal);
  }
  // A hand-close is the cheapest label there is -- you generate it just by using the tool.
  try {
    const { recordImplicit } = await import('./record.js');
    await recordImplicit(closedDecisions, 'missed');
  } catch (e) {
    console.warn('[tabby] could not record feedback for a manual close', e);
  }

  return { closed: ids.length, missing: missing.length, requested: tabIds.length };
}
