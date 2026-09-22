// @ts-check
/**
 * Straight to api.typesafe.ai. Hand-rolled rather than the official SDK: that package is
 * Node-declared, refuses to run in a browser without `dangerouslyAllowBrowser`, and would
 * drag in a build step this project otherwise does not need. The request is three fields.
 */

import { withRetry } from './backoff.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export class TransportError extends Error {
  /** @param {string} msg @param {object} [info] */
  constructor(msg, info = {}) {
    super(msg);
    this.name = 'TransportError';
    Object.assign(this, info);
  }
}

/**
 * @param {string} apiKey  '' when a proxy supplies the credential server-side
 * @param {string} [endpoint]
 * @returns {import('./index.js').Transport}
 */
export function makeDirect(apiKey, endpoint = ENDPOINT) {
  const usesProxy = endpoint !== ENDPOINT;
  return {
    async ask(req) {
      if (!apiKey && !usesProxy) throw new TransportError('no API key configured');

      const { status, value } = await withRetry(async () => {
        /** @type {Record<string,string>} */
        const headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        const r = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(req),
        });
        return { status: r.status, retryAfter: r.headers.get('retry-after'), value: r };
      });

      const res = /** @type {Response} */ (value);
      const text = await res.text();

      if (status === 401 || status === 403) {
        throw new TransportError('authentication failed -- check the API key', { status });
      }
      if (!res.ok) {
        throw new TransportError(`HTTP ${status}`, {
          status,
          requestId: res.headers.get('x-typesafe-request-id'),
          body: text.slice(0, 600),
        });
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new TransportError('response was not JSON', { status, body: text.slice(0, 300) });
      }
    },
  };
}
