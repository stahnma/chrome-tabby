// Throwaway spike. The whole project hinges on whether this file can reach the API.
//
// A chrome-extension:// *page* is an ordinary CORS origin and api.typesafe.ai rejects it
// ("Disallowed CORS origin"). An MV3 service worker holding host_permissions is generally
// exempt from page CORS -- but TypeSafe documents nothing either way, so we measure it.

const BASE = 'https://api.typesafe.ai';

/** The smallest request that still exercises the real POST path (and thus a preflight). */
function probeBody() {
  return {
    model: 'jev-1.13.0',
    state: { tabs: [{ title: 'chrome.alarms | Chrome Extensions', url: 'https://developer.chrome.com/docs/extensions/reference/api/alarms' }] },
    questions: {
      t0_probe: {
        type: 'noul',
        instructions: 'Consider only the single browser tab described at `tabs[0]`, using `tabs[0].title` and `tabs[0].url`. Is this reference documentation?',
      },
    },
  };
}

export async function probe(apiKey) {
  const out = {};

  // GET first: simple request, no preflight. Isolates auth problems from CORS problems.
  try {
    const r = await fetch(`${BASE}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    out.models = { ok: r.ok, status: r.status, body: (await r.text()).slice(0, 400) };
  } catch (e) {
    out.models = { ok: false, threw: String(e) };
  }

  // POST with Authorization + application/json -- this is the one that triggers a preflight.
  try {
    const r = await fetch(`${BASE}/v1/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(probeBody()),
    });
    out.systemone = {
      ok: r.ok,
      status: r.status,
      requestId: r.headers.get('x-typesafe-request-id'),
      body: (await r.text()).slice(0, 800),
    };
  } catch (e) {
    // A CORS rejection surfaces here as an opaque TypeError, not a status code.
    out.systemone = { ok: false, threw: String(e) };
  }

  return out;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'probe') return;
  probe(msg.apiKey).then(sendResponse).catch((e) => sendResponse({ fatal: String(e) }));
  return true; // keep the port open for the async reply
});
