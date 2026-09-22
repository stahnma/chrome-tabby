// @ts-check
/**
 * URL sanitizing. Pure, so it is testable without Chrome.
 *
 * This is the privacy boundary: nothing leaves the browser except what survives here.
 * Query strings and fragments routinely carry session tokens, one-time auth codes, search
 * terms, and internal identifiers, and none of it improves the judgment -- the title
 * already says what a page is.
 *
 * Deliberately no per-site allowlist ("but keep ?v= for YouTube"). That is a slippery
 * slope straight back to leaking the things this function exists to strip.
 *
 * Paths need the same treatment: one-time auth links put the secret IN the path
 * (fly.io/app/auth/cli/<token>), so stripping only the query string is not enough.
 */

/** A UUID in any of the usual shapes. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Does this path segment look like an opaque identifier or secret rather than a word?
 *
 * Deliberately conservative about what it keeps: readable slugs carry the meaning the
 * model actually uses ("pull/397/changes", "snippets/issues/18"), while long unbroken
 * alphanumeric runs carry none -- so redacting them costs nothing and removes a whole
 * class of accidental leak. The title supplies the meaning either way.
 *
 * @param {string} seg
 */
export function looksOpaque(seg) {
  if (UUID.test(seg)) return true;
  if (seg.length < 20) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(seg)) return false;
  // A readable slug breaks into words; a token does not.
  if (seg.includes('-') && /[aeiou]/i.test(seg) && seg.split('-').every((w) => w.length <= 14)) return false;
  return true;
}

/** @param {string} pathname */
export function redactPath(pathname) {
  return pathname
    .split('/')
    .map((seg) => (looksOpaque(seg) ? '…' : seg))
    .join('/');
}

/**
 * @param {string} raw
 * @returns {string} origin + pathname, or '' if unparseable
 */
export function sanitizeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return '';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    // Out of scope for closing anyway; keep the scheme so hard skips can report it.
    return `${u.protocol}${u.pathname}`;
  }
  // Drop a lone trailing slash so "/docs" and "/docs/" share one cache entry.
  const trimmed = u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : u.pathname;
  return `${u.origin}${redactPath(trimmed)}`;
}

/** @param {string} raw @returns {string} */
export function hostnameOf(raw) {
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}
