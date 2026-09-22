// @ts-check
/**
 * Retry policy. Pure apart from the injected sleep, so it unit-tests without real waiting.
 * Defaults mirror the official SDK's RetryPolicy, which is the closest thing TypeSafe
 * publishes to a recommended backoff.
 */

export const DEFAULT_POLICY = {
  maxRetries: 2, // attempts after the first
  httpStatuses: [408, 429, 500, 501, 502, 503, 504, 529],
  backoffInitialMs: 500,
  backoffMaxMs: 5000,
  backoffJitter: 0.25, // fraction randomly SUBTRACTED, so delays only ever shrink
  maxRetryAfterMs: 60000,
};

/** @param {number} status @param {typeof DEFAULT_POLICY} policy */
export function isRetryableStatus(status, policy = DEFAULT_POLICY) {
  return policy.httpStatuses.includes(status) || (status >= 500 && status <= 599);
}

/**
 * `Retry-After` is either seconds or an HTTP date. Returns ms, or undefined.
 * @param {string|null|undefined} header
 * @param {number} now
 */
export function parseRetryAfter(header, now = Date.now()) {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(header);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

/**
 * @param {number} attempt  0 for the first retry
 * @param {typeof DEFAULT_POLICY} policy
 * @param {number|undefined} retryAfterMs
 * @param {number} rand  in [0,1); injectable for tests
 */
export function computeDelay(attempt, policy = DEFAULT_POLICY, retryAfterMs = undefined, rand = Math.random()) {
  if (retryAfterMs !== undefined && retryAfterMs <= policy.maxRetryAfterMs) return retryAfterMs;
  const base = Math.min(policy.backoffInitialMs * 2 ** attempt, policy.backoffMaxMs);
  return Math.round(base * (1 - policy.backoffJitter * rand));
}

/**
 * Run `attempt`, retrying transient failures.
 *
 * `attempt` must return {status, retryAfter?, value?} or throw. A thrown error is treated
 * as a connection failure and retried.
 *
 * @template T
 * @param {(n:number) => Promise<{status:number, retryAfter?:string|null, value?:T}>} attempt
 * @param {object} [opts]
 * @param {typeof DEFAULT_POLICY} [opts.policy]
 * @param {(ms:number)=>Promise<void>} [opts.sleep]
 * @param {()=>number} [opts.rand]
 * @returns {Promise<{status:number, value?:T, attempts:number}>}
 */
export async function withRetry(attempt, opts = {}) {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rand = opts.rand ?? Math.random;

  let lastError;
  for (let n = 0; n <= policy.maxRetries; n++) {
    let res;
    try {
      res = await attempt(n);
    } catch (e) {
      lastError = e;
      if (n === policy.maxRetries) break;
      await sleep(computeDelay(n, policy, undefined, rand()));
      continue;
    }
    if (!isRetryableStatus(res.status, policy) || n === policy.maxRetries) {
      return { ...res, attempts: n + 1 };
    }
    await sleep(computeDelay(n, policy, parseRetryAfter(res.retryAfter), rand()));
  }
  throw lastError ?? new Error('retries exhausted');
}
