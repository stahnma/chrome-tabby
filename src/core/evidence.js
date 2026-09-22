// @ts-check
/**
 * The identity of a tab, as far as the model and the cache are concerned.
 *
 * Evidence is {title, url} and nothing else -- deliberately time-invariant. Putting
 * `lastAccessed`, `pinned`, or `audible` in here would change the hash on every run,
 * so every tab would be re-judged nightly forever and the cache would never hit.
 * Those are crisp local facts; they belong in decide(), not in the evidence.
 */

/** @param {{title?: string, url: string}} tab */
export function evidenceOf(tab) {
  return { title: (tab.title ?? '').trim(), url: tab.url };
}

/** Stable key order, so the hash does not depend on object construction order. */
function canonicalJson(/** @type {{title:string,url:string}} */ e) {
  return JSON.stringify([e.title, e.url]);
}

/**
 * @param {{title?: string, url: string}} tab
 * @returns {Promise<string>} 16 hex chars -- plenty for a per-profile cache key
 */
export async function evidenceHash(tab) {
  return sha256Hex(canonicalJson(evidenceOf(tab)));
}

/** @param {string} s @returns {Promise<string>} */
export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
