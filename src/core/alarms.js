// @ts-check
/**
 * Scheduling.
 *
 * The nightly alarm is one-shot and re-armed after every run, rather than
 * `periodInMinutes: 1440`. A 1440-minute period drifts across DST and ignores a changed
 * schedule; recomputing the next local occurrence each time does neither.
 *
 * Alarms do not fire while Chrome is closed, and fire late (or coalesced) after a wake,
 * so the alarm is never the only trigger. `shouldCatchUp` is the real gate.
 */

import { getSettings, getRunState, setRunState } from './storage.js';
import { runNow, isRunning, dayKey } from './run.js';

export const NIGHTLY = 'tabby.nightly';
export const HEARTBEAT = 'tabby.heartbeat';
const HEARTBEAT_MINUTES = 30;
const STALE_TICK_MS = 2 * 60e3;

/**
 * Next local hour:minute strictly after `now`.
 * PURE. Uses local-time constructors so DST is the platform's problem, not ours.
 *
 * @param {{hour:number, minute:number}} schedule
 * @param {number} now
 * @returns {number} ms epoch
 */
export function nextLocalOccurrence(schedule, now = Date.now()) {
  const d = new Date(now);
  const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), schedule.hour, schedule.minute, 0, 0);
  if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1);
  return candidate.getTime();
}

/**
 * Was today's scheduled time already passed, and is today's run still owed?
 * PURE -- this is the piece worth testing, and it needs no chrome.
 *
 * @param {object} args
 * @param {{lastCompletedDayKey:string|null}} args.runState
 * @param {import('./schema.js').Settings} args.settings
 * @param {number} args.now
 * @returns {{run:boolean, reason:string, hoursLate?:number}}
 */
export function shouldCatchUp({ runState, settings, now }) {
  const d = new Date(now);
  const scheduledToday = new Date(
    d.getFullYear(), d.getMonth(), d.getDate(), settings.schedule.hour, settings.schedule.minute, 0, 0).getTime();

  if (now < scheduledToday) return { run: false, reason: 'not yet due today' };

  const today = dayKey(d);
  if (runState.lastCompletedDayKey === today) return { run: false, reason: 'already ran today' };

  const hoursLate = (now - scheduledToday) / 3600e3;
  const cap = settings.shadowMode
    ? settings.catchUp.shadowMaxLateHours
    : settings.catchUp.liveMaxLateHours;

  if (hoursLate > cap) {
    // Live mode especially: waking the laptop at 2pm and having 25 tabs vanish is a bad
    // experience. Skipping a night costs nothing.
    return { run: false, reason: `${hoursLate.toFixed(1)}h late, past the ${cap}h cap`, hoursLate };
  }
  return { run: true, reason: `due, ${hoursLate.toFixed(1)}h late`, hoursLate };
}

/** Arm (or re-arm) the nightly one-shot and the heartbeat. */
export async function schedule(settings) {
  const s = settings ?? (await getSettings());
  const when = nextLocalOccurrence(s.schedule);
  await chrome.alarms.create(NIGHTLY, { when });
  await chrome.alarms.create(HEARTBEAT, { periodInMinutes: HEARTBEAT_MINUTES });
  return when;
}

/**
 * Run if one is owed. Called from both alarms, onStartup, onInstalled, and popup open.
 * Safe to call as often as you like.
 */
export async function maybeCatchUp(now = Date.now()) {
  const [settings, runState] = await Promise.all([getSettings(), getRunState()]);

  // A run that died mid-flight gets resumed before anything new is started.
  if (runState.phase !== 'idle' && now - (runState.lastTickAt ?? 0) > STALE_TICK_MS) {
    if ((runState.attempts ?? 0) >= 3) {
      await setRunState({ phase: 'idle', runId: null, attempts: 0, lastCompletedDayKey: runState.lastCompletedDayKey });
      return { action: 'abandoned', reason: 'too many failed resumes' };
    }
    const summary = await runNow({ force: true });
    await schedule(settings);
    return { action: 'resumed', summary };
  }

  if (isRunning(runState, now)) return { action: 'skip', reason: 'already running' };

  const verdict = shouldCatchUp({ runState, settings, now });
  if (!verdict.run) return { action: 'skip', reason: verdict.reason };

  const summary = await runNow();
  await schedule(settings);
  return { action: 'ran', reason: verdict.reason, summary };
}
