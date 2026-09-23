// @ts-check
/**
 * Acting on tabs from a UI page: closing them, and jumping to them.
 *
 * Normally this goes through the service worker, which keeps a single writer for storage.
 * But an MV3 worker is torn down when idle and does not always answer the message that is
 * meant to wake it -- and a close button that silently does nothing is worse than a brief
 * double-writer window on a user-initiated action.
 *
 * So: ask the worker first, and if it does not answer, do the same work here. An extension
 * page holds the same chrome.tabs permissions the worker does.
 */

import { send } from './msg.js';
import { closeTabs as closeTabsDirect } from '../core/execute.js';
import { sanitizeUrl } from '../core/url.js';

/**
 * @param {number[]} tabIds
 * @returns {Promise<{closed:number, missing:number, requested:number, via:'worker'|'page'}>}
 */
export async function closeTabs(tabIds) {
  try {
    const r = await send('closeTabs', { tabIds });
    return { ...r, via: 'worker' };
  } catch (e) {
    // Only fall back when the worker was unreachable. A real error from inside the
    // handler must surface, not get silently retried against the same broken logic.
    if (!/did not answer|no response/i.test(String(e?.message ?? e))) throw e;
    console.warn('[tabby] service worker unreachable; closing from the page instead', e);
    const r = await closeTabsDirect(tabIds);
    return { ...r, via: 'page' };
  }
}

/**
 * Bring a tab to the front, window and all.
 *
 * Same stale-id problem as closing: a proposal can outlive a browser restart, after which
 * every id in it is renumbered. The sanitized URL is the durable identity, so fall back to
 * it rather than reporting "gone" for a tab that is sitting right there.
 *
 * Done in the page rather than through the service worker: an extension page holds the
 * same chrome.tabs permissions, and this is a user gesture that should never wait on a
 * worker wake-up.
 *
 * @param {{tabId:number, url:string}} target
 * @returns {Promise<{ok:boolean, reason?:string}>}
 */
export async function focusTab({ tabId, url }) {
  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    const want = sanitizeUrl(url);
    const all = await chrome.tabs.query({});
    tab = all.find((t) => sanitizeUrl(t.url ?? '') === want) ?? null;
  }
  if (!tab || tab.id === undefined) return { ok: false, reason: 'that tab is no longer open' };

  await chrome.tabs.update(tab.id, { active: true });
  // Activating is not enough when the tab lives in another window.
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch { /* single-window setups, or the window is already focused */ }
  return { ok: true };
}
