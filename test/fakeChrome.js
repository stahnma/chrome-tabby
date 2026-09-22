// @ts-check
/**
 * Just enough of the extension APIs to run the real pipeline in Node.
 * Not a general-purpose mock -- only what src/ actually calls.
 */
export function installFakeChrome({ tabs = [] } = {}) {
  const store = {};
  const removed = [];
  const created = [];
  let badge = '';

  const fake = {
    storage: {
      local: {
        async get(key) {
          if (key === null || key === undefined) return { ...store };
          if (typeof key === 'string') return key in store ? { [key]: store[key] } : {};
          return Object.fromEntries(Object.keys(key).filter((k) => k in store).map((k) => [k, store[k]]));
        },
        async set(obj) { Object.assign(store, structuredClone(obj)); },
      },
    },
    tabs: {
      TAB_ID_NONE: -1,
      async query() { return structuredClone(tabs); },
      async get(id) {
        const t = tabs.find((x) => x.id === id);
        if (!t) throw new Error('No tab with id: ' + id);
        return structuredClone(t);
      },
      async remove(ids) {
        for (const id of [ids].flat()) {
          const i = tabs.findIndex((t) => t.id === id);
          if (i >= 0) removed.push(tabs.splice(i, 1)[0]);
        }
      },
      async create(props) { created.push(props); return { id: 9000 + created.length, ...props }; },
    },
    action: {
      async setBadgeText({ text }) { badge = text; },
      async setBadgeBackgroundColor() {},
    },
    alarms: {
      _set: {},
      async create(name, info) { this._set[name] = info; },
      async get(name) { return this._set[name] ?? null; },
    },
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} }, onMessage: { addListener() {} } },
  };

  globalThis.chrome = fake;
  return { store, removed, created, tabs, badge: () => badge, fake };
}

/** @param {object} over */
export function fakeTab(over = {}) {
  return {
    id: 1, windowId: 10, title: 'Example', url: 'https://example.com/page',
    lastAccessed: Date.now() - 30 * 864e5, pinned: false, audible: false, active: false,
    favIconUrl: 'https://example.com/favicon.ico', ...over,
  };
}
