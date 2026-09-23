// @ts-check
/**
 * Service worker entry. Thin on purpose: wiring only, logic lives in core/.
 */

import { runNow, previewNow, isRunning, repin } from './core/run.js';
import { schedule, maybeCatchUp, nextLocalOccurrence, NIGHTLY, HEARTBEAT } from './core/alarms.js';
import { restore } from './core/archive.js';
import { closeTabs } from './core/execute.js';
import { diagnose } from './core/diagnose.js';
import { recordFeedback } from './core/record.js';
import { sweepThresholds, previewChange, REASONS } from './core/feedback.js';
import {
  ensureSchema, getSettings, patchSettings, getApiKey, setApiKey,
  getProposal, getArchive, getRunState, getRunLog, dump, resetSettings, getFeedback,
  scheduleChanged,
} from './core/storage.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return;
  handler(msg)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true; // async reply; also keeps the worker alive while a UI page waits
});

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSchema();
  await schedule();
  await maybeCatchUp();
});

chrome.runtime.onStartup.addListener(async () => {
  // Alarms survive a restart, but a run owed while Chrome was closed never fired.
  await schedule();
  await maybeCatchUp();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== NIGHTLY && alarm.name !== HEARTBEAT) return;
  await maybeCatchUp();
  // The nightly is one-shot, so re-arm it regardless of whether a run happened.
  if (alarm.name === NIGHTLY) await schedule();
});

/** Message router. Every UI page reaches the API and storage through here, never directly. */
const HANDLERS = {
  ping: async () => ({ ok: true }),
  run: async (msg) => runNow({ mode: msg.mode }),
  preview: async (msg) => previewNow(msg.settings ?? {}),
  repin: async () => repin(),
  status: async () => {
    const rs = await getRunState();
    const settings = await getSettings();
    const alarm = await chrome.alarms.get(NIGHTLY).catch(() => null);
    return {
      runState: rs,
      running: isRunning(rs),
      log: (await getRunLog()).slice(0, 5),
      nextRunAt: alarm?.scheduledTime ?? nextLocalOccurrence(settings.schedule),
    };
  },
  catchUp: async () => maybeCatchUp(),
  reschedule: async () => ({ when: await schedule() }),
  getSettings: async () => ({ settings: await getSettings(), hasApiKey: !!(await getApiKey()) }),
  patchSettings: async (msg) => {
    const before = await getSettings();
    const next = await patchSettings(msg.patch ?? {});
    if (scheduleChanged(before, next)) await schedule(next);
    return next;
  },
  setApiKey: async (msg) => { await setApiKey(msg.apiKey ?? ''); return { ok: true }; },
  resetSettings: async () => resetSettings(),
  getProposal: async () => getProposal(),
  getArchive: async () => getArchive(),
  restore: async (msg) => restore(msg.id),
  closeTabs: async (msg) => closeTabs(msg.tabIds ?? []),
  dump: async (msg) => dump(msg.key),
  diagnose: async () => diagnose(),
  reasons: async () => REASONS,
  getFeedback: async () => getFeedback(),
  feedback: async (msg) => recordFeedback(msg.entry),
  tune: async () => {
    const [labels, settings, proposal] = await Promise.all([getFeedback(), getSettings(), getProposal()]);
    const sweep = sweepThresholds(labels, settings);
    return { ...sweep, flips: previewChange(proposal?.items ?? [], settings, sweep.thresholds) };
  },
  applyThresholds: async (msg) => patchSettings({ thresholds: msg.thresholds }),
};

// Dev REPL. `chrome://extensions` -> "service worker" -> console.
Object.assign(globalThis, {
  tabby: {
    runNow, previewNow, repin, dump, getSettings, patchSettings,
    getProposal, getArchive, getRunLog, getRunState, schedule, maybeCatchUp, closeTabs, diagnose,
  },
});
