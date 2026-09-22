# Tabby

A personal Chrome extension that judges every open tab each night and archives + closes the
ones that are safe to close.

Judgments come from [TypeSafe AI's **Jev**](https://docs.typesafe.ai) — a "System One" model
that returns typed decisions with calibrated probabilities rather than text. It is not an LLM
and cannot be fine-tuned; the policy layered on top of it is what learns.

## Running it

```sh
npm test        # 185 tests + a static check, no browser needed
```

Load the repo root as an unpacked extension (`chrome://extensions` → Developer mode →
Load unpacked). It ships in **shadow mode with a mock transport**, so the first run costs
nothing, touches no network, and closes nothing — it just stages a proposal over your real
tabs. Add an API key in Settings and switch transport to `direct` for real judgments.

Reloading: UI pages (`popup`, `options`, `review`) pick up changes when you reopen them.
Anything the service worker runs needs `chrome.runtime.reload()` from its console, or ↻ on
the extensions page.

## How it fits together

```
tabs.js      snapshot every tab, sanitize the URL
evaluate.js  ask Jev for whatever the cache is missing   <- the only step that costs money
decide.js    pure: judgments + settings + now -> close/keep
execute.js   shadow: stage a proposal. live: archive, then close.
```

The split between `evaluate` and `decide` is the central design decision. Raw judgments are
persisted, and `decide()` is a pure function over them, so **changing a threshold re-decides
instantly at zero cost** — you can replay every past night against new settings without
re-asking anything.

## Decisions worth knowing

**Evidence is `{title, url}` and nothing else.** No recency, no tab flags. Those change every
run, so including them would change the cache key every run and re-bill inference nightly.
Time lives in `decide()`, never in the model state.

**The judgment cache is keyed per facet**, on a hash of that question's exact instruction text
*and* criteria *and* the model version. Rewording one question re-asks only that question.

**Pin a concrete model version.** `jev-latest` resolves to something concrete in the response,
which can never equal the alias — so it would miss the cache on every single tab. A run that
sees an alias re-pins itself.

**Gates, not a weighted score.** Probabilities from separate questions cannot be combined
arithmetically (a noul and its negation do not sum to 1), so each condition stands alone.
It is also far easier to debug: every kept tab names the gate that stopped it.

**Query strings, fragments, and opaque path segments are stripped** before anything leaves the
browser. Paths matter too — one-time auth links put the secret in the path.

**A false close costs 3× a false keep** in the tuner. Closing something you wanted destroys
work; leaving a stale tab open costs nothing.

## Layout

| path | what it owns |
|---|---|
| `src/core/decide.js` | the rule engine — pure, and where the real logic lives |
| `src/core/questions.js` | the prompts; the product's behavior is this prose |
| `src/core/evaluate.js` | cache partitioning, chunking, calling the transport |
| `src/core/feedback.js` | scoring your labels, sweeping thresholds |
| `src/transport/` | `direct` (real), `proxy` (key stays server-side), `mock` (offline) |
| `src/ui/` | popup, options, review |
| `spike/cors/` | throwaway; answered whether a service worker can reach the API. It can. |

`decide.js`, `evidence.js`, `questions.js`, `url.js`, `feedback.js` and `backoff.js` never
reference `chrome.*`. That is enforced by `test/linkcheck.mjs` and is why the tests need no
browser and no mocking.
