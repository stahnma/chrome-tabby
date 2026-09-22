// @ts-check
/**
 * One call that answers "what state is this thing actually in?".
 *
 * Exists because the service worker console is the only place a developer can reach the
 * extension's internals, and every round trip through a human costs real time. Everything
 * here is read-only.
 */

import { getSettings, getJudgments, getProposal, getRunLog, getRunState, getApiKey } from './storage.js';
import { questionHashes } from './questions.js';
import { ASK_FACETS, REQUIRED_FACETS, SCHEMA_VERSION } from './schema.js';

export async function diagnose() {
  const [settings, judgments, proposal, log, runState, apiKey, qh] = await Promise.all([
    getSettings(), getJudgments(), getProposal(), getRunLog(), getRunState(), getApiKey(), questionHashes(),
  ]);

  const entries = Object.values(judgments);
  const withAnswers = entries.filter((j) => Object.keys(j.answers ?? {}).length);

  // Which facets are actually present, and are they at the current wording and model?
  const coverage = {};
  for (const f of ASK_FACETS) {
    const have = withAnswers.filter((j) => j.answers[f] !== undefined);
    const current = have.filter((j) => j.answers[f].qh === qh[f] && j.answers[f].m === settings.model);
    coverage[f] = `${have.length}/${withAnswers.length} present, ${current.length} at current wording+model`;
  }

  const items = proposal?.items ?? [];
  const keepReasons = {};
  for (const d of items.filter((d) => d.action === 'keep')) {
    const c = d.reasons?.[0]?.code ?? 'UNKNOWN';
    keepReasons[c] = (keepReasons[c] ?? 0) + 1;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    settingsVersion: settings.v,
    hasApiKey: !!apiKey,
    transport: settings.transport,
    model: settings.model,
    gates: {
      minAgeHours: settings.minAgeHours,
      staleAfterDays: settings.staleAfterDays,
      maxClosesPerRun: settings.maxClosesPerRun,
      thresholds: settings.thresholds,
    },
    askFacets: [...ASK_FACETS],
    requiredFacets: [...REQUIRED_FACETS],
    questionHashes: qh,
    judgments: { total: entries.length, answered: withAnswers.length, coverage },
    proposal: proposal
      ? { runId: proposal.runId, at: new Date(proposal.createdAt).toISOString(), mode: proposal.mode,
          tabs: items.length, close: items.filter((d) => d.action === 'close').length, keepReasons }
      : null,
    runState,
    lastRuns: log.slice(0, 3),
    // A sample so the raw shape is visible, with the text trimmed off.
    sampleJudgment: withAnswers[0]
      ? { url: withAnswers[0].url, answers: withAnswers[0].answers }
      : null,
  };
}
