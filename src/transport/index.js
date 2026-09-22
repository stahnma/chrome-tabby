// @ts-check
/**
 * Transport selection.
 *
 * The CORS spike settled the open question: a privileged extension context holding
 * host_permissions is not subject to page CORS, so `direct` works from both the service
 * worker and extension pages. (The earlier curl probe that appeared to show a block was
 * measuring the server's origin allowlist, which Chrome never consults for these contexts.)
 *
 * We still route every call through the service worker as policy, not necessity: the API
 * key has no business being reachable from a page's JS context.
 *
 * @typedef {{ask: (req:object) => Promise<{model:string, answers:Record<string,any>, usage?:object}>}} Transport
 */

import { makeDirect } from './direct.js';
import { makeProxy } from './proxy.js';
import { makeMock } from './mock.js';

/**
 * @param {import('../core/schema.js').Settings} settings
 * @param {string} apiKey
 * @returns {Transport}
 */
export function makeTransport(settings, apiKey) {
  switch (settings.transport?.mode) {
    case 'mock':
      return makeMock();
    case 'proxy':
      return makeProxy(settings.transport.proxyUrl);
    default:
      return makeDirect(apiKey);
  }
}
