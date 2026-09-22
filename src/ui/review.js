// @ts-check
import { send, $, el, setChildren, StaleContextError, showStaleBanner } from './msg.js';
import { closeTabs } from './close.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

const fmtAge = (h) => (h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);

/** Human labels for the gate codes, so the page reads as prose rather than enum names. */
const LABELS = {
  PINNED: 'Pinned', AUDIBLE: 'Playing audio', ACTIVE: 'Active tab',
  LAST_IN_WINDOW: 'Only tab in its window', SCHEME: 'Not a web page',
  DENYLIST: 'Denylisted host', BAD_URL: 'Unreadable URL', WINDOW_LIMIT: 'Outside the debug window',
  FACETS_MISSING: 'Not judged yet', TOO_RECENT: 'Viewed too recently',
  WIP: 'Looks like work in progress', SAVED_FOR_LATER: 'Looks deliberately saved',
  NOT_DISPOSABLE_OR_RETRIEVABLE: 'Neither disposable nor easy to find again',
  PROTECTED_CATEGORY: 'Protected category', CAP_REACHED: 'Over the per-run cap',
  UNKNOWN: 'Unclassified',
};

const FACETS = [
  ['dead', 'Error or sign-in wall', 'closes a tab at or above the line'],
  ['wip', 'Work in progress', 'keeps a tab at or above the line'],
  ['savedForLater', 'Saved for later', 'keeps a tab at or above the line'],
  ['disposable', 'Disposable', 'allows a close at or above the line'],
  ['retrievable', 'Retrievable', 'allows a close at or above the line'],
];

const tip = () => document.getElementById('tip');
function showTip(evt, text) {
  const t = tip();
  t.textContent = text;
  t.style.opacity = '1';
  t.style.left = `${Math.min(evt.clientX + 12, innerWidth - t.offsetWidth - 8)}px`;
  t.style.top = `${evt.clientY + 14}px`;
}
const hideTip = () => { tip().style.opacity = '0'; };

/**
 * A histogram of one facet's values, with the active threshold drawn on it.
 * Single series, so no legend — the heading names it.
 */
function histogram(values, threshold, label, hint) {
  // PAD_T reserves a band above the plot for the threshold label, so it can never
  // collide with a bar however tall the bar gets.
  const BINS = 10, W = 240, H = 128, PAD_L = 20, PAD_B = 16, PAD_T = 18;
  const counts = new Array(BINS).fill(0);
  for (const v of values) counts[Math.min(BINS - 1, Math.floor(v * BINS))]++;
  const max = Math.max(1, ...counts);

  const plotW = W - PAD_L, plotH = H - PAD_B - PAD_T;
  const x = (i) => PAD_L + (i / BINS) * plotW;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${label} distribution` });

  // Baseline and two y ticks; deliberately recessive.
  svg.append(svgEl('line', { class: 'axis', x1: PAD_L, y1: PAD_T + plotH, x2: W, y2: PAD_T + plotH }));
  for (const [val, y] of [[max, PAD_T], [0, PAD_T + plotH]]) {
    const t = svgEl('text', { class: 'tick', x: PAD_L - 4, y: y + 3, 'text-anchor': 'end' });
    t.textContent = String(val);
    svg.append(t);
  }
  for (const v of [0, 0.5, 1]) {
    const t = svgEl('text', { class: 'tick', x: PAD_L + v * plotW, y: H - 4, 'text-anchor': v === 0 ? 'start' : v === 1 ? 'end' : 'middle' });
    t.textContent = v.toFixed(1);
    svg.append(t);
  }

  const bw = plotW / BINS;
  counts.forEach((c, i) => {
    const h = (c / max) * plotH;
    if (c > 0) {
      // 2px surface gap between neighbours; 4px rounded ends at the free edge.
      svg.append(svgEl('rect', {
        class: 'bin', x: x(i) + 1, y: PAD_T + plotH - h, width: Math.max(1, bw - 2), height: h, rx: Math.min(4, h / 2),
      }));
    }
    const hit = svgEl('rect', { class: 'hit', x: x(i), y: PAD_T, width: bw, height: plotH });
    const lo = (i / BINS).toFixed(1), hi = ((i + 1) / BINS).toFixed(1);
    hit.addEventListener('mousemove', (e) => showTip(e, `${lo}–${hi}: ${c} tab${c === 1 ? '' : 's'}`));
    hit.addEventListener('mouseleave', hideTip);
    svg.append(hit);
  });

  if (typeof threshold === 'number') {
    const tx = PAD_L + threshold * plotW;
    svg.append(svgEl('line', { class: 'thresh', x1: tx, y1: PAD_T - 6, x2: tx, y2: PAD_T + plotH }));
    // Anchor the label so it stays inside the plot at either extreme.
    const nearRight = tx > PAD_L + plotW * 0.8;
    const lbl = svgEl('text', {
      class: 'threshLabel', x: nearRight ? tx - 4 : tx + 4, y: PAD_T - 8,
      'text-anchor': nearRight ? 'end' : 'start',
    });
    lbl.textContent = threshold.toFixed(2);
    svg.append(lbl);
  }

  return el('div', { className: 'chart' },
    el('h3', { textContent: label }),
    el('div', { className: 'sub', textContent: hint }),
    svg);
}

/** A one-click opinion. Typing a reason is friction; four buttons is not. */
function fbButton(d, reason, text, onFeedback) {
  const b = el('button', { className: 'link fb', textContent: text, title: REASON_HINTS[reason] ?? '' });
  b.addEventListener('click', async () => {
    b.disabled = true;
    b.textContent = '\u2026';
    try {
      await onFeedback(d, reason);
    } catch (e) {
      b.disabled = false;
      b.textContent = 'retry';
      b.title = String(e.message ?? e);
    }
  });
  return b;
}

const REASON_HINTS = {
  needed: 'It proposed closing this and was wrong',
  dead: 'This is an error page, 404, or logged-out screen',
  never: 'Add this host to the never-close list',
  always: 'Close this host from now on without asking',
};

function row(d, onClose, onFeedback) {
  const btn = el('button', { className: 'link', textContent: 'close' });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await onClose(d.tabId);
    } catch (e) {
      if (e instanceof StaleContextError) return showStaleBanner();
      btn.disabled = false;
      btn.textContent = 'retry';
      btn.title = String(e.message ?? e);
      console.error('[tabby] close failed', e);
    }
  });
  return el('tr', {},
    el('td', { className: 'age', textContent: fmtAge(d.ageHours) }),
    el('td', {},
      el('div', { textContent: d.title || '(untitled)' }),
      el('div', { className: 'url', textContent: d.url })),
    el('td', { className: 'why', textContent: d.reasons.map((r) => r.detail).join(' · ') }),
    el('td', { className: 'act' },
      // Offer only the opinions that make sense for what it decided.
      onFeedback
        ? (d.action === 'close'
            ? [fbButton(d, 'needed', 'keep it', onFeedback), fbButton(d, 'never', 'never this site', onFeedback)]
            : [fbButton(d, 'dead', 'dead', onFeedback), fbButton(d, 'always', 'always this site', onFeedback)])
        : [],
      btn));
}

const table = (items, onClose, onFeedback) => el('table', {}, items.map((d) => row(d, onClose, onFeedback)));

function archiveRow(e, onRestore) {
  const btn = el('button', { className: 'link', textContent: e.restoredAt ? 'restored' : 'restore' });
  btn.disabled = !!e.restoredAt;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '\u2026';
    try { await onRestore(e.id); } catch (err) { btn.disabled = false; btn.textContent = 'retry'; btn.title = String(err.message ?? err); }
  });
  // Three states, not two. Entries predating attribution have no `by`, and guessing at
  // them would assert something untrue -- a missing field is not evidence of 'auto'.
  const why = e.by === 'manual' ? 'closed by you'
    : e.by === 'auto' ? 'closed by a run'
    : 'closed before this was recorded';
  return el('tr', {},
    el('td', { className: 'age', textContent: new Date(e.closedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }),
    el('td', {},
      el('div', { textContent: e.title || '(untitled)' }),
      el('div', { className: 'url', textContent: e.url })),
    el('td', { className: 'why', textContent: `${why}${e.ageHours ? ` \u00b7 was ${Math.round(e.ageHours / 24)}d stale` : ''}` }),
    el('td', { className: 'act' }, btn));
}

async function load() {
  const [proposal, { settings }, archive] = await Promise.all([
    send('getProposal'), send('getSettings'), send('getArchive'),
  ]);
  if (!proposal) { $('#meta').textContent = 'No run yet.'; return; }

  const onFeedback = async (d, reason) => {
    const { ruleAdded } = await send('feedback', {
      entry: { evidenceHash: d.evidenceHash, url: d.url, title: d.title, ageHours: d.ageHours, reason },
    });
    if (ruleAdded) {
      $('#meta').textContent = `Added ${ruleAdded.host} to ${ruleAdded.list === 'denylist' ? 'never-close' : 'always-close'}.`;
    }
    load();
  };

  const closeThen = async (tabIds) => {
    const r = await closeTabs(tabIds);
    if (r.missing) {
      $('#meta').textContent =
        `${r.missing} of ${r.requested} tab(s) were already gone -- the proposal was stale. Run again for current ids.`;
    }
    load();
  };

  setChildren($('#meta'), [
    el('strong', { textContent: proposal.mode === 'shadow' ? 'Shadow run' : 'Live run' }),
    el('span', { className: 'muted', textContent: ` · ${new Date(proposal.createdAt).toLocaleString()}` }),
  ]);

  const s = proposal.settingsSnapshot ?? {};
  $('#snap').textContent = s.thresholds
    ? `model ${s.model} · min age ${s.minAgeHours}h · cap ${s.maxClosesPerRun}`
    : '';

  const items = proposal.items;
  const closers = items.filter((d) => d.action === 'close');
  const judged = items.filter((d) => typeof d.facets?.wip === 'number');

  const oldest = items.reduce((a, d) => Math.max(a, d.ageHours), 0);
  const median = (arr) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)] : 0);

  setChildren($('#tiles'), [
    ['Tabs', items.length], ['Would close', closers.length],
    ['Judged', `${judged.length}/${items.length}`],
    ['Median age', fmtAge(median(items.map((d) => d.ageHours)))],
    ['Oldest', fmtAge(oldest)],
  ].map(([k, n]) => el('div', { className: 'tile' },
    el('div', { className: 'n', textContent: String(n) }),
    el('div', { className: 'k', textContent: k }))));

  setChildren($('#charts'), judged.length
    ? FACETS.map(([key, label, hint]) =>
        histogram(judged.map((d) => d.facets[key]).filter((v) => typeof v === 'number'),
          settings.thresholds[key], label, hint))
    : el('div', { className: 'empty', textContent: 'Nothing judged yet — run once with a transport configured.' }));

  $('#closeCount').textContent = `(${closers.length})`;
  $('#closeAll').disabled = closers.length === 0;
  setChildren($('#closers'), closers.length
    ? table(closers, (id) => closeThen([id]), onFeedback)
    : el('div', { className: 'empty', textContent: 'Nothing met the bar.' }));

  // Grouping keeps by gate is the fastest way to see which threshold is doing the work.
  const byReason = new Map();
  for (const d of items.filter((x) => x.action === 'keep')) {
    const code = d.reasons[0]?.code ?? 'UNKNOWN';
    if (!byReason.has(code)) byReason.set(code, []);
    byReason.get(code).push(d);
  }
  setChildren($('#keepers'), [...byReason.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([code, group]) => el('details', { className: 'group' },
      el('summary', { textContent: `${LABELS[code] ?? code} — ${group.length}` }),
      table(group, (id) => closeThen([id]), onFeedback))));

  setChildren($('#closed'), archive.length
    ? el('table', {}, archive.slice(0, 50).map((e) =>
        archiveRow(e, async (id) => { await send('restore', { id }); load(); })))
    : el('div', { className: 'empty', textContent: 'Nothing closed yet.' }));

  await renderTuning();

  $('#closeAll').onclick = async () => {
    $('#closeAll').disabled = true;
    await closeThen(closers.map((d) => d.tabId));
  };
}

async function renderTuning() {
  const t = await send('tune');
  const box = $('#tune');

  if (!t.enoughData) {
    setChildren(box, el('div', { className: 'muted' },
      `${t.current.total} label${t.current.total === 1 ? '' : 's'} so far — at least 5 are needed before ` +
      `suggesting anything. Every tab you close by hand, restore, or rate above becomes one.`));
    return;
  }

  const pct = (n) => `${Math.round(n * 100)}%`;
  const improved = t.best.cost < t.current.cost;

  const kids = [
    el('div', {},
      `Scored against ${t.current.total} of your decisions. Current settings agree with `,
      el('strong', { textContent: pct(t.current.accuracy) }),
      ` (${t.current.falseClose} closed that you wanted, ${t.current.falseKeep} kept that you did not).`),
  ];

  if (!improved) {
    kids.push(el('div', { className: 'ok', textContent: 'No change would do better on this feedback. Leave it alone.' }));
  } else {
    kids.push(el('div', {},
      'Suggested: agreement ',
      el('strong', { textContent: pct(t.best.accuracy) }),
      ` (${t.best.falseClose} wrong closes, ${t.best.falseKeep} wrong keeps).`));
    kids.push(el('table', {}, t.moves.map((m) => el('tr', {},
      el('td', { className: 'move', textContent: m.facet }),
      el('td', { className: 'move', textContent: `${m.from.toFixed(2)} → ${m.to.toFixed(2)}` }),
      el('td', { className: 'why', textContent: `resolves ${m.fixed} point${m.fixed === 1 ? '' : 's'} of disagreement` })))));

    const flips = t.flips ?? { toClose: [], toKeep: [] };
    kids.push(el('div', { className: 'muted' },
      `On the current proposal that would close ${flips.toClose.length} more and spare ${flips.toKeep.length}.`));

    const apply = el('button', { className: 'primary', textContent: 'Apply these thresholds' });
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      await send('applyThresholds', { thresholds: t.thresholds });
      load();
    });
    kids.push(apply);
  }

  setChildren(box, kids);
}

load().catch((e) => {
  if (e instanceof StaleContextError) return showStaleBanner();
  $('#meta').textContent = String(e.message ?? e);
});
