// @ts-check
/**
 * The step that costs money. Partition against the cache, chunk what's left, ask, store.
 *
 * The planning half is pure and exported separately, because "did the cache work?" is the
 * question most worth testing and it needs no browser and no network.
 */

import { buildQuestions, buildState, parseAnswers, questionHashes } from './questions.js';
import { ASK_FACETS } from './schema.js';
import { mergeJudgments } from './storage.js';

/**
 * Which facets does each tab still need asked?
 *
 * An answer is reusable only if the facet exists, was produced by the current model, and
 * came from the current wording of that question. Any mismatch re-asks just that facet.
 *
 * PURE.
 *
 * @param {(import('./schema.js').TabFact & {evidenceHash:string})[]} tabs
 * @param {Record<string, import('./schema.js').Judgment>} judgments
 * @param {Record<string,string>} qhashes  facet -> instruction hash
 * @param {string} model
 * @param {readonly string[]} [wanted]  defaults to everything the decision can use
 * @returns {{asks: {tab:any, facets:string[]}[], cachedTabs:number, askedFacets:number}}
 */
export function planAsks(tabs, judgments, qhashes, model, wanted = ASK_FACETS) {
  const asks = [];
  let cachedTabs = 0;
  let askedFacets = 0;

  for (const tab of tabs) {
    const answers = judgments[tab.evidenceHash]?.answers ?? {};
    const needed = wanted.filter((f) => {
      const a = answers[f];
      return !a || a.m !== model || a.qh !== qhashes[f];
    });
    if (needed.length === 0) { cachedTabs++; continue; }
    asks.push({ tab, facets: needed });
    askedFacets += needed.length;
  }
  return { asks, cachedTabs, askedFacets };
}

/** PURE. @template T @param {T[]} arr @param {number} size @returns {T[][]} */
export function chunk(arr, size) {
  if (size < 1) throw new RangeError('chunk size must be >= 1');
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Turn one chunk's response into judgment records.
 * PURE.
 *
 * @param {{tab:any, facets:string[]}[]} group
 * @param {{answers?:Record<string,any>, model?:string}} response
 * @param {Record<string,string>} qhashes
 * @param {number} now
 */
export function foldResponse(group, response, qhashes, now) {
  /** @type {Record<string, import('./schema.js').Judgment>} */
  const updates = {};
  const model = response.model ?? 'unknown';

  for (const { index, facet, value } of parseAnswers(response)) {
    const entry = group[index];
    if (!entry) continue;
    const { tab } = entry;
    updates[tab.evidenceHash] ??= {
      url: tab.url, title: tab.title, firstSeen: now, lastSeen: now, answers: {},
    };
    updates[tab.evidenceHash].answers[facet] = { v: value, qh: qhashes[facet] ?? '', m: model, at: now };
  }
  return updates;
}

/**
 * Ask for everything missing and persist it.
 *
 * @param {object} args
 * @param {(import('./schema.js').TabFact & {evidenceHash:string})[]} args.tabs
 * @param {Record<string, import('./schema.js').Judgment>} args.judgments
 * @param {import('./schema.js').Settings} args.settings
 * @param {import('../transport/index.js').Transport} args.transport
 * @param {number} [args.startChunk]  resume point
 * @param {(progress:{chunk:number, of:number, tokens:number}) => Promise<void>|void} [args.onChunk]
 */
export async function evaluate({ tabs, judgments, settings, transport, startChunk = 0, onChunk }) {
  const now = Date.now();
  const qhashes = await questionHashes();
  const { asks, cachedTabs, askedFacets } = planAsks(tabs, judgments, qhashes, settings.model);
  const groups = chunk(asks, settings.chunkSize);

  let tokens = 0;
  let answeredModel = null;
  const failed = [];

  for (let i = startChunk; i < groups.length; i++) {
    const group = groups[i];
    const req = {
      model: settings.model,
      state: buildState(group.map((g) => g.tab)),
      questions: buildQuestions(group),
    };
    try {
      const res = await transport.ask(req);
      tokens += res?.usage?.input_tokens ?? 0;
      answeredModel ??= res?.model ?? null;
      await mergeJudgments(foldResponse(group, res, qhashes, now));
    } catch (e) {
      // A dead chunk just means those tabs have no judgment this run, and decide() keeps
      // anything it cannot judge. Never let one bad chunk abort the whole night.
      failed.push({ chunk: i, error: String(e?.message ?? e) });
    }
    await onChunk?.({ chunk: i + 1, of: groups.length, tokens });
  }

  // Touch lastSeen for everything we saw, cached or not -- this is what drives pruning.
  /** @type {Record<string, any>} */
  const seen = {};
  for (const t of tabs) {
    seen[t.evidenceHash] = { url: t.url, title: t.title, firstSeen: now, lastSeen: now, answers: {} };
  }
  await mergeJudgments(seen);

  return { chunks: groups.length, cachedTabs, askedTabs: asks.length, askedFacets, tokens, failed, answeredModel };
}
