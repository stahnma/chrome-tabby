// @ts-check
/**
 * One nightly run, start to finish.
 *
 * Progress is persisted after every chunk. That buys two things at once: the run resumes
 * if the service worker is torn down mid-flight, and every storage write resets the ~30s
 * idle timer, so in practice it usually is not torn down at all.
 */

import { snapshot } from './tabs.js';
import { evaluate } from './evaluate.js';
import { decide } from './decide.js';
import { execute } from './execute.js';
import { pruneJudgments } from './storage.js';
import { pruneArchive } from './archive.js';
import {
  getSettings, getApiKey, getJudgments, getRunState, setRunState, pushRunLog, patchSettings,
} from './storage.js';
import { makeTransport } from '../transport/index.js';

export const dayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const STALE_TICK_MS = 2 * 60e3;

/** Moving targets. Storing one of these as the pin defeats the judgment cache. */
const ALIASES = new Set(['jev-latest', 'jev-preview']);

/** Is a previous run still in flight, and still alive? */
export function isRunning(runState, now = Date.now()) {
  return runState.phase !== 'idle' && now - (runState.lastTickAt ?? 0) < STALE_TICK_MS;
}

/**
 * @param {object} [opts]
 * @param {'shadow'|'live'} [opts.mode]   overrides settings.shadowMode for this run only
 * @param {boolean} [opts.force]          ignore the single-flight guard
 */
export async function runNow(opts = {}) {
  const prev = await getRunState();
  if (!opts.force && isRunning(prev)) {
    return { skipped: 'already-running', phase: prev.phase };
  }

  const runId = new Date().toISOString();
  const started = Date.now();
  let settings = await getSettings();
  if (opts.mode) settings = { ...settings, shadowMode: opts.mode === 'shadow' };

  const nowMs = started + (settings.debug?.nowOffsetHours ?? 0) * 3600e3;

  try {
    await setRunState({ phase: 'snapshot', runId, attempts: (prev.attempts ?? 0) + 1, lastCompletedDayKey: prev.lastCompletedDayKey });
    const tabs = await snapshot();

    await setRunState({ phase: 'evaluating', runId, cursor: 0, lastCompletedDayKey: prev.lastCompletedDayKey });
    const transport = makeTransport(settings, await getApiKey());
    const evalSummary = await evaluate({
      tabs,
      judgments: await getJudgments(),
      settings,
      transport,
      onChunk: async ({ chunk: c }) => {
        await setRunState({ phase: 'evaluating', runId, cursor: c, lastCompletedDayKey: prev.lastCompletedDayKey });
      },
    });

    // An alias in settings.model can never match the concrete version the API stamps on
    // each answer, so the cache would miss every single night. Pin what actually answered.
    if (ALIASES.has(settings.model) && evalSummary.answeredModel && !ALIASES.has(evalSummary.answeredModel)) {
      settings = await patchSettings({ model: evalSummary.answeredModel });
    }

    await setRunState({ phase: 'deciding', runId, lastCompletedDayKey: prev.lastCompletedDayKey });
    const decisions = decide({ tabs, judgments: await getJudgments(), settings, now: nowMs });

    await setRunState({ phase: 'executing', runId, lastCompletedDayKey: prev.lastCompletedDayKey });
    const result = await execute({ decisions, settings, tabs, runId });

    await pruneJudgments(settings.judgmentMaxIdleDays);
    await pruneArchive(settings.archiveCap, settings.archiveMaxDays);

    const summary = {
      runId,
      at: started,
      ms: Date.now() - started,
      mode: result.mode,
      tabs: tabs.length,
      ...evalSummary,
      proposedClose: decisions.closeCount,
      kept: decisions.keepCount,
      closed: result.closed ?? 0,
      skipped: result.skipped ?? 0,
    };
    await pushRunLog(summary);
    await setRunState({ phase: 'idle', runId: null, attempts: 0, lastCompletedDayKey: dayKey() });
    return summary;
  } catch (e) {
    const failure = { runId, at: started, ms: Date.now() - started, error: String(e?.stack ?? e) };
    await pushRunLog(failure);
    await setRunState({ phase: 'idle', runId: null, attempts: 0, lastCompletedDayKey: prev.lastCompletedDayKey });
    throw e;
  }
}

/** Recompute decisions from stored judgments. No API calls -- this is the tuning path. */
export async function previewNow(settingsOverride = {}) {
  const settings = { ...(await getSettings()), ...settingsOverride };
  const tabs = await snapshot();
  const now = Date.now() + (settings.debug?.nowOffsetHours ?? 0) * 3600e3;
  return decide({ tabs, judgments: await getJudgments(), settings, now });
}

/**
 * Ask the API which concrete version `jev-latest` currently is, and pin that.
 *
 * GET /v1/models only advertises aliases, so this is the only way to discover a concrete
 * id -- the response to any request echoes the version that actually answered it.
 */
export async function repin() {
  const settings = await getSettings();
  const transport = makeTransport({ ...settings, model: 'jev-latest' }, await getApiKey());
  const res = await transport.ask({
    model: 'jev-latest',
    state: { tabs: [{ title: 'Example Domain', url: 'https://example.com/' }] },
    questions: {
      t0_probe: {
        type: 'noul',
        instructions: 'Consider only the single browser tab described at `tabs[0]`, using `tabs[0].title` and `tabs[0].url`. Is this a placeholder or example page?',
      },
    },
  });
  const model = res?.model;
  if (!model || model === 'jev-latest') throw new Error(`could not resolve a concrete version (got ${model ?? 'nothing'})`);
  await patchSettings({ model });
  return { model };
}
