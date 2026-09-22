// @ts-check
import { send, $, el, setChildren } from './msg.js';

const NOULS = [
  ['dead', 'Error or sign-in wall', 'close if at or above, overriding the keeps'],
  ['wip', 'Work in progress', 'keep if at or above'],
  ['savedForLater', 'Saved for later', 'keep if at or above'],
  ['disposable', 'Disposable', 'closeable if at or above'],
  ['retrievable', 'Retrievable', 'closeable if at or above'],
];

let settings;

function renderThresholds() {
  setChildren($('#thresholds'), NOULS.map(([key, label, hint]) => {
    const out = el('span', { className: 'muted', textContent: settings.thresholds[key].toFixed(2) });
    const input = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(settings.thresholds[key]) });
    input.style.width = '100%';
    input.addEventListener('input', () => {
      settings.thresholds[key] = Number(input.value);
      out.textContent = Number(input.value).toFixed(2);
      schedulePreview();
    });
    return el('div', {},
      el('label', { textContent: `${label} — ${hint}` }),
      el('div', { className: 'row' }, el('span', { className: 'grow' }, input), out));
  }));
}

let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 120);
}

async function runPreview() {
  try {
    const d = await send('preview', { settings: collect() });
    const closers = d.items.filter((x) => x.action === 'close');
    $('#previewOut').textContent =
      `Right now this would close ${closers.length} of ${d.items.length} tabs` +
      (closers.length ? `: ${closers.slice(0, 3).map((c) => c.title || c.url).join(' · ')}${closers.length > 3 ? ' …' : ''}` : '.');
  } catch (e) {
    $('#previewOut').textContent = `preview unavailable: ${e.message ?? e}`;
  }
}

function collect() {
  return {
    ...settings,
    shadowMode: $('#shadowMode').checked,
    model: $('#model').value.trim(),
    transport: { mode: $('#transport').value, proxyUrl: $('#proxyUrl').value.trim() },
    minAgeHours: Number($('#minAgeHours').value),
    staleAfterDays: Number($('#staleAfterDays').value),
    maxClosesPerRun: Number($('#maxClosesPerRun').value),
    chunkSize: Number($('#chunkSize').value),
    schedule: { ...settings.schedule, hour: Number($('#hour').value) },
    denylist: $('#denylist').value.split('\n').map((s) => s.trim()).filter(Boolean),
  };
}

function syncLiveGate() {
  const wantsLive = !$('#shadowMode').checked;
  const blocked = wantsLive && !settings.hasVerifiedRestore;
  const warn = $('#liveWarn');
  warn.hidden = !wantsLive;
  warn.textContent = blocked
    ? 'Live mode closes tabs silently with no undo, so the archive is the only safety net. Restore one archived tab from the popup first — that unlocks this.'
    : 'Live mode is on. Tabs will be archived and closed without asking.';
  if (blocked) $('#shadowMode').checked = true;
  $('#proxyWrap').hidden = $('#transport').value !== 'proxy';
}

async function load() {
  const got = await send('getSettings');
  settings = got.settings;
  $('#apiKey').placeholder = got.hasApiKey ? 'saved — type to replace' : 'stored locally, never synced';
  $('#model').value = settings.model;
  $('#transport').value = settings.transport.mode;
  $('#proxyUrl').value = settings.transport.proxyUrl ?? '';
  $('#shadowMode').checked = settings.shadowMode;
  $('#minAgeHours').value = settings.minAgeHours;
  $('#staleAfterDays').value = settings.staleAfterDays;
  $('#maxClosesPerRun').value = settings.maxClosesPerRun;
  $('#chunkSize').value = settings.chunkSize;
  $('#hour').value = settings.schedule.hour;
  $('#denylist').value = settings.denylist.join('\n');
  renderThresholds();
  syncLiveGate();
  runPreview();
}

$('#saveKey').addEventListener('click', async () => {
  await send('setApiKey', { apiKey: $('#apiKey').value });
  $('#apiKey').value = '';
  $('#apiKey').placeholder = 'saved — type to replace';
  $('#msg').textContent = 'key saved';
});

$('#repin').addEventListener('click', async () => {
  $('#msg').textContent = 'asking jev-latest what it resolves to...';
  try {
    const r = await send('repin');
    $('#model').value = r.model;
    $('#msg').textContent = `pinned ${r.model}`;
  } catch (e) {
    $('#msg').textContent = `re-pin failed: ${e.message ?? e}`;
  }
});

$('#reset').addEventListener('click', async () => {
  // Saved settings shadow every later default, so an explicit escape hatch matters.
  settings = await send('resetSettings');
  await load();
  $('#msg').textContent = 'reset to defaults';
});

$('#save').addEventListener('click', async () => {
  settings = await send('patchSettings', { patch: collect() });
  $('#msg').textContent = 'saved';
  syncLiveGate();
  runPreview();
});

for (const id of ['#shadowMode', '#transport']) $(id).addEventListener('change', syncLiveGate);
for (const id of ['#minAgeHours', '#maxClosesPerRun', '#staleAfterDays']) $(id).addEventListener('input', schedulePreview);

load().catch((e) => { $('#msg').textContent = String(e.message ?? e); });
