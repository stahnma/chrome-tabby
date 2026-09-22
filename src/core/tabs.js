// @ts-check
/**
 * Reading the browser's tabs. The one place chrome.tabs is touched for input.
 */

import { sanitizeUrl } from './url.js';
import { evidenceHash } from './evidence.js';

/**
 * Every open tab, sanitized and hashed, ready for evaluate() and decide().
 *
 * Note `windowTabCount`: decide() refuses to close the last tab in a window, since that
 * closes the window too. It has to be counted here, where we can see the whole picture.
 *
 * @returns {Promise<(import('./schema.js').TabFact & {evidenceHash:string})[]>}
 */
export async function snapshot() {
  const raw = await chrome.tabs.query({});

  /** @type {Map<number, number>} */
  const perWindow = new Map();
  for (const t of raw) perWindow.set(t.windowId, (perWindow.get(t.windowId) ?? 0) + 1);

  const out = [];
  for (const t of raw) {
    if (t.id === undefined || t.id === chrome.tabs.TAB_ID_NONE) continue;
    const url = sanitizeUrl(t.url ?? t.pendingUrl ?? '');
    const title = (t.title ?? '').trim();
    out.push({
      tabId: t.id,
      windowId: t.windowId,
      evidenceHash: await evidenceHash({ title, url }),
      title,
      url,
      favIconUrl: typeof t.favIconUrl === 'string' && t.favIconUrl.startsWith('http') ? t.favIconUrl : undefined,
      // lastAccessed is Chrome 121+. Fall back to "now" so a missing value reads as fresh
      // and therefore never gets closed -- failing safe.
      lastAccessed: /** @type {any} */ (t).lastAccessed ?? Date.now(),
      pinned: !!t.pinned,
      audible: !!t.audible,
      active: !!t.active,
      windowTabCount: perWindow.get(t.windowId) ?? 1,
      groupTitle: undefined,
    });
  }
  return out;
}

/**
 * Confirm a tab still looks the way it did when we judged it, immediately before closing.
 * Guards the case where you touched the tab while the run was in flight.
 *
 * @param {number} tabId
 * @param {number} expectedLastAccessed
 */
export async function stillUntouched(tabId, expectedLastAccessed) {
  try {
    const t = await chrome.tabs.get(tabId);
    if (!t || t.active || t.pinned || t.audible) return false;
    const la = /** @type {any} */ (t).lastAccessed;
    return la === undefined || la <= expectedLastAccessed;
  } catch {
    return false; // already gone
  }
}
