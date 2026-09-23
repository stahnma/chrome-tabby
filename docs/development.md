# Development

## Running the tests

```sh
npm test         # 191 tests plus a static check; no browser, no mocking
npm run typecheck # tsc over src/ -- the code is plain JS with JSDoc types
```

Both run on every pull request (`.github/workflows/test.yml`), and `main` requires them
to pass.

The suite runs under `node --test` because most of the codebase never touches `chrome.*`.
`decide.js`, `evidence.js`, `questions.js`, `url.js`, `feedback.js` and `backoff.js` are pure,
and `test/linkcheck.mjs` fails the build if any of them reach for a browser API. That rule is
what keeps the tests fast and honest — the logic worth testing is testable directly.

`test/fakeChrome.js` covers the rest: just enough of `chrome.storage`, `chrome.tabs`,
`chrome.action` and `chrome.alarms` to drive a full run in Node. `test/integration.test.js`
uses it to exercise `runNow()` end to end.

`linkcheck.mjs` also verifies that every relative import resolves, every manifest entry point
exists, every message type the UI sends has a handler, no HTML uses inline event handlers
(MV3's CSP kills them silently), and nothing calls `replaceChildren` directly.

## Reloading

UI pages (`popup`, `options`, `review`) re-read from disk when you reopen them — no extension
reload needed. Anything the service worker runs does need one:

```js
chrome.runtime.reload()      // from the service worker console
```

An extension page open at reload time is orphaned: its `chrome.runtime` points at a dead
context and every message fails. `msg.js` detects that and shows a banner, but close and
reopen the page rather than refreshing it.

## Layout

| path | what it owns |
|---|---|
| `src/core/decide.js` | the rule engine — pure, and where the real logic lives |
| `src/core/questions.js` | the prompts; the product's behavior is this prose |
| `src/core/evaluate.js` | cache partitioning, chunking, calling the transport |
| `src/core/run.js` | the resumable run state machine |
| `src/core/feedback.js` | scoring your labels, sweeping thresholds |
| `src/core/schema.js` | storage keys, defaults, and the settings migration |
| `src/transport/` | `direct` (real), `proxy` (key stays server-side), `mock` (offline) |
| `src/ui/` | popup, options, review |

```
tabs.js      snapshot every tab, sanitize the URL
evaluate.js  ask Jev for whatever the cache is missing   <- the only step that costs money
decide.js    pure: judgments + settings + now -> close/keep
execute.js   shadow: stage a proposal. live: archive, then close.
```

## Decisions worth knowing

**The evaluate/decide split is the central one.** Raw judgments are persisted and `decide()`
is a pure function over them, so changing a threshold re-decides instantly at zero cost. It is
what makes both the live preview and the feedback tuner possible.

**Evidence is `{title, url}` and nothing else.** No recency, no tab flags. Those change every
run, so including them would change the cache key every run and re-bill inference nightly.
Time lives in `decide()`, never in the model state. This is the highest-leverage constraint in
the codebase and the easiest to break by accident.

**The judgment cache is keyed per facet**, on a hash of that question's exact instruction text
*and* its criteria *and* the model version. Rewording one question re-asks only that question.
If you add a facet, add it to `ASK_FACETS` — `REQUIRED_FACETS` is a different list (what must
exist before a tab can be judged at all) and conflating them means the facet is never
requested and its gate silently never fires.

**Pin a concrete model version.** `jev-latest` resolves to something concrete in the response,
which can never equal the alias — so it would miss the cache on every tab, every night. A run
that sees an alias re-pins itself.

**Gates, not a weighted score.** Probabilities from separate questions cannot be combined
arithmetically (a noul and its negation do not sum to 1), so each condition stands alone. It
is also far easier to debug: every kept tab names the gate that stopped it.

**Settings migrate, they don't merge.** Stored settings override defaults, so once anything is
saved the whole object freezes and later default changes never reach the user. `migrateSettings`
bumps a field only when it still holds a known superseded default, so a deliberate choice is
never overwritten. Changing a default means adding a migration step.

**The service worker cannot be relied on to answer.** MV3 tears it down when idle and the
message meant to wake it can be dropped. `msg.js` retries once; `close.js` falls back to doing
the work in the page, which holds the same permissions.

**A false close costs 3× a false keep** in the tuner. Closing something you wanted destroys
work; leaving a stale tab open costs nothing.

## Working on the prompts

`questions.js` is where behavior actually lives, and it is prose, so it resists unit testing.
Two things help:

- Changing wording or criteria changes that facet's cache key, so a reworded question re-asks
  only itself. Iterating is cheap.
- A few tests assert that specific decisions survive rewording — that `wip` still rules out
  404s and login walls, for instance. They exist because those clauses were added in response
  to real misjudgments and would be easy to drop by accident.

Bear in mind the model's absolute scale is compressed: an observed 404 scored `wip` 0.29 while
a genuine open pull request scored 0.55. No threshold separates those, which is why `dead` is
its own question rather than more wording inside `wip`. When a judgment looks wrong, ask
whether it needs a sharper question or a *different* one.

## Debugging

The service worker console (`chrome://extensions` → Tabby → service worker) exposes:

```js
await tabby.diagnose()        // settings in force, facet coverage, keep reasons, last runs
await tabby.runNow()          // returns the run summary
await tabby.previewNow()      // re-decide from cache, no API call
await tabby.dump('judgments') // raw stored judgments
```

`diagnose()` is usually the fastest way to tell a tuning problem from a bug: if a facet shows
`0/74 present`, nothing downstream matters until that is fixed.
