// @ts-check
import { send, $, el, setChildren, StaleContextError, showStaleBanner } from './msg.js';
import { closeTabs } from './close.js';

const fmtAge = (h) => (h < 48 ? `${Math.round(h)}h` : `${Math.round(h / 24)}d`);
const fmtWhen = (ms) => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function decisionRow(d, onClose) {
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
  return el('div', { className: `item ${d.action === 'close' ? 'close-b' : 'keep-b'}` },
    el('div', { className: 'row' },
      el('div', { className: 'title grow', textContent: d.title || '(untitled)', title: d.title }), btn),
    el('div', { className: 'url', textContent: d.url }),
    el('div', { className: 'why', textContent: `${fmtAge(d.ageHours)} · ${d.reasons.map((r) => r.detail).join(' · ')}` }));
}

function archiveRow(entry, onRestore) {
  const btn = el('button', { className: 'link', textContent: entry.restoredAt ? 'restored' : 'restore' });
  btn.disabled = !!entry.restoredAt;
  btn.addEventListener('click', async () => { btn.disabled = true; btn.textContent = '...'; await onRestore(entry.id); });
  return el('div', { className: 'item' },
    el('div', { className: 'row' },
      el('div', { className: 'title grow', textContent: entry.title || '(untitled)', title: entry.title }), btn),
    el('div', { className: 'url', textContent: entry.url }),
    el('div', { className: 'why', textContent: `closed ${fmtWhen(entry.closedAt)}` }));
}

async function refresh() {
  const [{ settings }, proposal, archive, status] = await Promise.all([
    send('getSettings'), send('getProposal'), send('getArchive'), send('status'),
  ]);

  const mode = settings.shadowMode ? 'shadow' : 'LIVE';
  // Never let "mock" be mistaken for real judgments.
  $('#mode').textContent = settings.transport.mode === 'direct' ? mode : `${mode} · ${settings.transport.mode}`;
  $('#mode').className = settings.shadowMode ? 'muted' : 'err';

  $('#next').textContent = status.nextRunAt ? `next run ${fmtWhen(status.nextRunAt)}` : '';

  const last = status.log?.[0];
  $('#status').textContent = status.running
    ? `running (${status.runState.phase})...`
    : last
      ? (last.error ? `last run failed` : `last run ${fmtWhen(last.at)} · ${last.askedTabs ?? 0} asked, ${last.cachedTabs ?? 0} cached`)
      : '';

  const closers = (proposal?.items ?? []).filter((d) => d.action === 'close');
  $('#count').textContent = proposal ? `(${closers.length})` : '';
  const closeThen = async (tabIds) => {
    try {
      const r = await closeTabs(tabIds);
      if (r.missing) $('#error').textContent = `${r.missing} tab(s) were already gone.`;
    } catch (e) {
      $('#error').textContent = String(e.message ?? e);
    }
    refresh();
  };

  setChildren($('#proposal'),
    closers.length
      ? closers.map((d) => decisionRow(d, (id) => closeThen([id])))
      : el('div', { className: 'empty', textContent: proposal ? 'Nothing met the bar.' : 'No run yet.' }));

  setChildren($('#archive'),
    archive.length
      ? archive.slice(0, 25).map((e) => archiveRow(e, async (id) => { await send('restore', { id }); refresh(); }))
      : el('div', { className: 'empty', textContent: 'Nothing archived.' }));
}

$('#run').addEventListener('click', async () => {
  const btn = $('#run');
  btn.disabled = true;
  $('#error').textContent = '';
  $('#status').textContent = 'running...';
  try {
    await send('run');
  } catch (e) {
    $('#error').textContent = String(e.message ?? e);
  } finally {
    btn.disabled = false;
    refresh();
  }
});

$('#opts').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#review').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/review.html') }));

refresh().catch((e) => {
  if (e instanceof StaleContextError) return showStaleBanner();
  $('#error').textContent = String(e.message ?? e);
});
