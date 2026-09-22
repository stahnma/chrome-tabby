// @ts-check
/**
 * The question catalog -- the product's actual behavior lives in this prose.
 *
 * Two constraints from the TypeSafe docs shape every line here:
 *
 *  1. Question IDs are NOT sent to the model. `t3_wip` means nothing to it, so each
 *     instruction has to be completely self-contained and name its own backticked path.
 *  2. One state per request, so N tabs are judged by fanning out N x facets questions
 *     over a single state, not by sending N requests.
 */

import { NOUL_FACETS, CATEGORIES } from './schema.js';
import { sha256Hex } from './evidence.js';

/** Prefixed onto every facet question so the model knows what it is looking at. */
const PREAMBLE = (i) =>
  `Consider only the single browser tab described at \`tabs[${i}]\`, using \`tabs[${i}].title\` ` +
  `and \`tabs[${i}].url\`. Query strings and fragments have been removed from the URL, so the ` +
  `title often carries most of the meaning.`;

/**
 * Each facet is a function of the tab's index in the chunk.
 * Wording changes here invalidate only that facet's cached answers (see questionHashes).
 */
export const FACETS = {
  wip: {
    type: 'noul',
    keep: true, // high probability means keep
    instructions: (i) =>
      `${PREAMBLE(i)} Does this tab look like an unfinished task that the person still intends ` +
      `to come back to and act on -- for example an open pull request or code review, a bug ` +
      `report or ticket, a partially filled form, a checkout or payment flow, a document or ` +
      `message being drafted, a cloud console or admin panel in the middle of being configured, ` +
      `or a locally running development server? A page that failed to load or no longer exists ` +
      `is never work in progress, however task-like its address looks. Neither is a sign-in or ` +
      `login screen: when a site has logged the person out or their session has expired, whatever ` +
      `they were doing there is over, and signing in again is not itself the task. Answer for the ` +
      `likelihood that closing this tab right now would interrupt work that is genuinely in progress.`,
    criteria: {
      true: 'A working page holding a task the person is partway through and would resume.',
      false:
        'Anything they could not resume here: finished with, purely informational, or not ' +
        'reachable at all -- a 404 or "not found" page, "page unavailable", an expired or broken ' +
        'link, a server error, or a login, sign-in, or "session expired" screen shown in place ' +
        'of content the person is no longer authenticated to see.',
    },
  },
  disposable: {
    type: 'noul',
    keep: false,
    instructions: (i) =>
      `${PREAMBLE(i)} Does this tab look like something that has already served its purpose and ` +
      `would not be missed -- for example a search engine results page, a social media feed or ` +
      `timeline, a news or site homepage, a video or other media that has been watched, an ` +
      `advertisement or marketing landing page, an error page, or a page opened only to check one ` +
      `fact? Count a login or sign-in screen here too: a tab left sitting on one has almost always ` +
      `been logged out or timed out after the person finished, so the page in front of them is a ` +
      `shell rather than the thing they came for. Answer for the likelihood that this tab is ` +
      `transient, already-consumed content.`,
    criteria: {
      true:
        'Already served its purpose, or never had one -- including dead, errored and not-found ' +
        'pages, and login screens left behind by an expired session.',
      false:
        'Still holds something the person has not finished with. A sign-in screen they were ' +
        'deliberately part-way through, on a page opened moments ago, is not disposable.',
    },
  },
  retrievable: {
    type: 'noul',
    keep: false,
    instructions: (i) =>
      `${PREAMBLE(i)} Suppose this tab were closed and the person later wanted it back. Is it a ` +
      `stable, well-known, publicly reachable page that an obvious search or a guess at the URL ` +
      `would find again -- as opposed to a one-time or expiring link, a generated or private or ` +
      `internal page, a result buried deep in a long list, or something the person would struggle ` +
      `to describe well enough to search for? Answer for the likelihood that this page would be ` +
      `easy to find again.`,
    criteria: {
      true: 'A stable public address, or something an obvious search would surface again.',
      false: 'One-time, expiring, generated, private, internal, or buried too deep to re-find.',
    },
  },
  savedForLater: {
    type: 'noul',
    keep: true,
    instructions: (i) =>
      `${PREAMBLE(i)} Does this look like something the person deliberately left open in order to ` +
      `read or consult later -- a long-form article, a tutorial or how-to guide, reference ` +
      `documentation, a specification, a research paper, a recipe, or a product they are still ` +
      `evaluating -- rather than something they already finished with? Answer for the likelihood ` +
      `that this tab was kept open on purpose as saved reading or reference material.`,
    criteria: {
      true: 'Deliberately parked to read or consult later.',
      false: 'Landed on incidentally, already read, or not readable at all.',
    },
  },
  dead: {
    type: 'noul',
    keep: false,
    instructions: (i) =>
      `${PREAMBLE(i)} Is this tab showing an error or a barrier instead of the content it was ` +
      `opened for -- a "page not found" or 404, "this page is unavailable", a server or ` +
      `application error, an expired or broken link, or a login, sign-in or "your session has ` +
      `expired" screen standing where the content used to be? Judge what the page is showing ` +
      `now, not what its address suggests it once held: an address that looks like a document, ` +
      `a ticket or an account page still counts here if the page itself is an error or a ` +
      `sign-in wall.`,
    criteria: {
      true:
        'The visible page is an error, a not-found page, or a sign-in / session-expired screen ' +
        '-- there is no content on it to come back to.',
      false: 'The page is showing real content, whatever that content happens to be.',
    },
  },
  category: {
    type: 'choice',
    criteria: CATEGORIES,
    instructions: (i) =>
      `${PREAMBLE(i)} Which one of the listed categories best describes what this page is? Choose ` +
      `the single closest match; choose \`other\` only if none of the others plausibly fit.`,
  },
};

/** Short, stable per-facet id used in question keys. */
const SLUG = { wip: 'wip', disposable: 'disp', retrievable: 'retr', savedForLater: 'save', dead: 'dead', category: 'cat' };
const SLUG_TO_FACET = Object.fromEntries(Object.entries(SLUG).map(([f, s]) => [s, f]));

/**
 * Hash of each facet's instruction text, used as the cache key `qh`.
 *
 * Index 0 is used purely as a representative: the wording is identical across indices
 * apart from the number, so this tracks genuine wording changes and not chunk position.
 * @returns {Promise<Record<string,string>>}
 */
export async function questionHashes() {
  /** @type {Record<string,string>} */
  const out = {};
  for (const [facet, def] of Object.entries(FACETS)) {
    out[facet] = await sha256Hex(def.instructions(0) + '||' + JSON.stringify(def.criteria ?? null));
  }
  return out;
}

/**
 * Build the questions map for one chunk.
 * @param {{facets: string[]}[]} chunk  one entry per tab, naming the facets that tab still needs
 * @returns {Record<string, {type:string, instructions:string, criteria?:any}>}
 */
export function buildQuestions(chunk) {
  /** @type {Record<string, any>} */
  const questions = {};
  chunk.forEach((entry, i) => {
    for (const facet of entry.facets) {
      const def = FACETS[/** @type {keyof typeof FACETS} */ (facet)];
      if (!def) continue;
      const q = { type: def.type, instructions: def.instructions(i) };
      // Nouls take a true/false rubric; choice takes the option list. Both ride here.
      if ('criteria' in def && def.criteria) q.criteria = def.criteria;
      questions[`t${i}_${SLUG[facet]}`] = q;
    }
  });
  return questions;
}

/** The state half of the request. Must line up index-for-index with the questions. */
export function buildState(/** @type {{title:string,url:string}[]} */ tabs) {
  return { tabs: tabs.map((t) => ({ title: t.title, url: t.url })) };
}

/**
 * Map a response's answers back to (tab index, facet) pairs.
 * @param {{answers?: Record<string, any>}} response
 * @returns {{index:number, facet:string, value:number|string}[]}
 */
export function parseAnswers(response) {
  const out = [];
  for (const [key, answer] of Object.entries(response?.answers ?? {})) {
    const m = /^t(\d+)_([a-z]+)$/.exec(key);
    if (!m) continue;
    const facet = SLUG_TO_FACET[m[2]];
    if (!facet) continue;

    let value;
    if (answer?.type === 'noul') value = answer.noul;
    else if (answer?.type === 'choice') value = answer.choice;
    else if (answer?.type === 'score') value = answer.score;
    if (value === undefined) continue;

    out.push({ index: Number(m[1]), facet, value });
  }
  return out;
}

export { NOUL_FACETS };
