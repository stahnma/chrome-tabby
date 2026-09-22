// @ts-check
/**
 * Same wire format, different host, no API key in the browser.
 *
 * Optional: the spike showed `direct` works. This exists for the day the key should live
 * on a Fly Sprite instead of in chrome.storage.local -- the proxy forwards the body
 * verbatim and adds the Authorization header server-side.
 */

import { makeDirect } from './direct.js';

/**
 * @param {string} proxyUrl
 * @returns {import('./index.js').Transport}
 */
export function makeProxy(proxyUrl) {
  if (!proxyUrl) throw new Error('proxy mode selected but no proxyUrl configured');
  // Same code path, no credential. The proxy supplies the key.
  return makeDirect('', proxyUrl.replace(/\/$/, '') + '/v1/systemone');
}
