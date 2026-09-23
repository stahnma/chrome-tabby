// @ts-check
/**
 * Thrown when this page outlived the extension that served it -- reloading the extension
 * (or an update) orphans every open extension page, and nothing it sends will ever arrive.
 * The only cure is reloading the page itself, so it gets its own error type.
 */
export class StaleContextError extends Error {
  constructor() {
    super('This page was left over from a previous version of the extension. Reload it.');
    this.name = 'StaleContextError';
  }
}

/** Every UI page talks to the service worker; none of them touch storage or the API. */
export async function send(type, extra = {}) {
  // chrome.runtime.id goes undefined the moment the context is invalidated.
  if (!chrome.runtime?.id) throw new StaleContextError();

  // A dormant service worker is woken BY this message, and can miss it if the wake-up
  // races listener registration -- sendMessage then resolves undefined rather than
  // throwing. One retry after a short beat is the documented cure.
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type, ...extra });
    } catch (e) {
      const m = String(e?.message ?? e);
      if (/context invalidated|Receiving end does not exist|message port closed/i.test(m)) {
        if (attempt === 0) { await new Promise((r) => setTimeout(r, 150)); continue; }
        throw new StaleContextError();
      }
      throw e;
    }
    if (res) {
      if (!res.ok) throw new Error(res.error ?? 'unknown error');
      return res.result;
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(
    `the service worker did not answer '${type}'. Open chrome://extensions -> Tabby -> ` +
    `"service worker" and check for a startup error.`);
}

/** A dismissable banner telling the user the only thing that will actually help. */
export function showStaleBanner() {
  if (document.getElementById('stale-banner')) return;
  const bar = document.createElement('div');
  bar.id = 'stale-banner';
  bar.style.cssText =
    'position:sticky;top:0;z-index:20;padding:8px 10px;margin:0 0 10px;border-radius:6px;' +
    'background:var(--card);border-left:3px solid var(--close);font:inherit';
  bar.textContent = 'This page is left over from a previous version of the extension. ';
  const btn = document.createElement('button');
  btn.textContent = 'Reload page';
  btn.addEventListener('click', () => location.reload());
  bar.append(btn);
  document.body.prepend(bar);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const el = (tag, props = {}, ...kids) => {
  // `dataset` is a read-only accessor, so Object.assign onto it throws under module
  // strict mode. Merge into it instead of replacing it.
  const { dataset, ...rest } = props;
  const n = Object.assign(document.createElement(tag), rest);
  if (dataset) Object.assign(n.dataset, dataset);
  for (const k of kids.flat(Infinity)) if (k != null) n.append(k);
  return n;
};

/**
 * Replace a node's children with one node, or an array of them.
 *
 * Use this instead of replaceChildren() directly: that takes varargs, so handing it an
 * array stringifies it to "[object HTMLDivElement],..." rather than failing loudly.
 *
 * @param {Element} node
 * @param {Node|Node[]|null} kids
 */
export const setChildren = (node, kids) => {
  node.replaceChildren(...[kids].flat(Infinity).filter((k) => k != null));
};
