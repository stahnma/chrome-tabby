# CORS spike

Throwaway. Delete once it has answered its question.

## Why

`api.typesafe.ai` empirically rejects a preflight from a `chrome-extension://` origin
(`Disallowed CORS origin`). An MV3 **service worker** holding `host_permissions` is generally
not subject to page CORS, so it should work — but TypeSafe documents nothing about this, so
it has to be measured before any real code is written.

## Run it

1. `chrome://extensions` → enable **Developer mode** (top right)
2. **Load unpacked** → select this directory (`spike/cors`)
3. Click **Details** → **Extension options**
4. Paste a TypeSafe API key, then click **both** buttons

## Reading the result

| Outcome | Meaning |
|---|---|
| SW works, page blocked | Expected. Proceed as planned; all network stays in the service worker. |
| Both work | Fine. Still keep network in the SW — the API key has no business in a page. |
| **Both blocked** | The Fly proxy is day 1, not later. Only `transport/index.js` changes. |
| HTTP 401/403 | Not a CORS result. The network path is fine; the key is wrong. Re-run with a good key. |

A CORS rejection shows up as a thrown `TypeError`, *not* a status code — that's the tell.
The GET to `/v1/models` runs first as a control: it's a simple request with no preflight, so
it separates "auth is broken" from "CORS is broken".

## Note

The key is stashed in `chrome.storage.local` under `spikeKey` purely so you don't retype it.
Remove the extension when you're done and it goes with it.
