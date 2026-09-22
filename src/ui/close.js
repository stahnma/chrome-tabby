// @ts-check
/**
 * Closing tabs from a UI page.
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
