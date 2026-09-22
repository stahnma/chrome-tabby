// MV3's CSP forbids inline handlers, hence this file.
import { probe } from './sw.js';

const $ = (id) => document.getElementById(id);
const out = $('out');
const verdict = $('verdict');

// Convenience only -- this is a throwaway spike, not the real extension.
chrome.storage.local.get('spikeKey').then(({ spikeKey }) => { if (spikeKey) $('key').value = spikeKey; });

function render(where, result) {
  out.textContent = JSON.stringify(result, null, 2);

  const post = result.systemone ?? {};
  const blocked = post.threw !== undefined;
  const authFailed = post.status === 401 || post.status === 403;

  let msg;
  let cls;
  if (blocked) {
    msg = `BLOCKED from ${where}. The POST threw instead of returning a status, which is what a CORS rejection looks like from fetch.`;
    cls = 'bad';
  } else if (authFailed) {
    msg = `Reached the server from ${where} (HTTP ${post.status}) — so the network path is FINE and CORS is not the problem. Fix the API key and re-run.`;
    cls = 'good';
  } else if (post.ok) {
    msg = `WORKS from ${where}. HTTP ${post.status}, request id ${post.requestId ?? '(none)'}.`;
    cls = 'good';
  } else {
    msg = `Reached the server from ${where} but got HTTP ${post.status}. Not a CORS problem — read the body below.`;
    cls = 'good';
  }
  verdict.className = `verdict ${cls}`;
  verdict.textContent = msg;
}

async function run(where) {
  const apiKey = $('key').value.trim();
  if (!apiKey) { verdict.className = 'verdict bad'; verdict.textContent = 'Enter an API key first.'; return; }
  await chrome.storage.local.set({ spikeKey: apiKey });

  out.textContent = `running from ${where}...`;
  verdict.textContent = '';
  try {
    const result = where === 'service worker'
      ? await chrome.runtime.sendMessage({ type: 'probe', apiKey })
      : await probe(apiKey);
    render(where, result);
  } catch (e) {
    verdict.className = 'verdict bad';
    verdict.textContent = `Harness error from ${where}: ${e}`;
    out.textContent = String(e?.stack ?? e);
  }
}

$('sw').addEventListener('click', () => run('service worker'));
$('page').addEventListener('click', () => run('page'));
