// @ts-check
/**
 * The safety net. Live mode closes silently, so this is the only way back.
 */

import { getArchive, setArchive, patchSettings } from './storage.js';

/**
 * @param {import('./schema.js').Decision} decision
 * @param {any} tab
 * @param {string} runId
 * @param {Record<string, any>} answers
 * @param {'auto'|'manual'} by  who closed it -- unrecoverable if not recorded here
 */
export function archiveEntry(decision, tab, runId, answers, by = 'auto') {
  return {
    id: `arc_${Date.now()}_${decision.tabId}`,
    closedAt: Date.now(),
    runId,
    by,
    title: decision.title,
    url: decision.url, // already sanitized
    // URL string only -- a base64 data: favicon is the one thing that would blow the quota.
    favIconUrl: typeof tab?.favIconUrl === 'string' && tab.favIconUrl.startsWith('http') ? tab.favIconUrl : undefined,
    windowId: decision.windowId,
    evidenceHash: decision.evidenceHash,
    ageHours: Math.round(decision.ageHours),
    answersSnapshot: answers, // why it died, for postmortems
    restoredAt: null,
  };
}

/** @param {any[]} entries */
export async function addToArchive(entries) {
  const archive = [...entries, ...(await getArchive())];
  await setArchive(archive);
  return archive;
}

/** Reopen an archived tab, unfocused. Marks it restored rather than deleting the record. */
export async function restore(id) {
  const archive = await getArchive();
  const entry = archive.find((e) => e.id === id);
  if (!entry) throw new Error(`no archive entry ${id}`);

  await chrome.tabs.create({ url: entry.url, active: false });
  entry.restoredAt = Date.now();
  await setArchive(archive);

  // Proving the safety net works is the gate for enabling live mode.
  await patchSettings({ hasVerifiedRestore: true });

  // And a restore is a label: it closed something you actually wanted.
  try {
    const { recordFeedback } = await import('./record.js');
    await recordFeedback({
      evidenceHash: entry.evidenceHash, url: entry.url, title: entry.title,
      ageHours: entry.ageHours ?? 0, reason: 'needed',
    });
  } catch (e) {
    console.warn('[tabby] could not record feedback for a restore', e);
  }

  return entry;
}

/** @param {number} cap @param {number} maxDays */
export async function pruneArchive(cap, maxDays, now = Date.now()) {
  const cutoff = now - maxDays * 864e5;
  const archive = (await getArchive())
    .filter((e) => (e.closedAt ?? 0) >= cutoff)
    .sort((a, b) => b.closedAt - a.closedAt)
    .slice(0, cap);
  await setArchive(archive);
  return archive.length;
}
