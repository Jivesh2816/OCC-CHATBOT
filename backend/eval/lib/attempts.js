// Running one live case, with retries, and deciding whether the result is a
// completed observation. Infrastructure only: nothing here changes what the
// app or the model sees, or how a completed case is scored.
//
// A case counts as completed only if its last attempt finished with no
// exception and no infrastructure failure (429, 5xx, network) on any model
// call. Anything else (retries exhausted, or a stop on the daily quota) is
// marked as an error: excluded from quality metrics, never cached, so a later
// --resume runs it again. A quota stop can land between two turns of the action
// agent's tool loop, after the first turn's tools already ran; that partial
// result is kept on the record for debugging but is not an observation.
const { isInfraError } = require('./llm-recorder');

const infraFailures = live => (live?.llm || []).filter(isInfraError);

// The one test for "this case ran to completion and may be cached and scored".
function isCompleteObservation(record) {
  return !!record.live && !record.error && infraFailures(record.live).length === 0;
}

// attempt() → the live record for one try (with .llm = that try's model calls).
// Returns { live, error, attempts, aborted }; aborted is set when a rate limit's
// retry-after exceeds maxWaitMs (usually the daily quota), so the run stops.
async function runAttempts({ attempt, maxAttempts, maxWaitMs, sleep, caseId }) {
  let live = null;
  let error = null;
  let attempts = 0;
  let aborted = null;
  for (let n = 1; n <= maxAttempts; n++) {
    attempts = n;
    error = null;
    try {
      live = await attempt();
    } catch (e) {
      error = { kind: 'exception', message: String(e?.message || e).slice(0, 300) };
    }
    // A rate-limited or failed model call degrades the app to its fallbacks,
    // which would be scored as a wrong answer. Retry the case instead; if it
    // keeps failing, it's reported under reliability, not quality.
    const failedCalls = infraFailures(live);
    if (!error && !failedCalls.length) break;
    const describe = () => failedCalls.map(call => `${call.stage}: ${call.error.status ?? ''} ${call.error.message}`).join('; ').slice(0, 300);
    const limited = failedCalls.find(call => call.error.status === 429);
    // Long waits usually mean the daily quota: stop cleanly so --resume can
    // continue later, instead of sleeping for hours. The case did not finish.
    if (limited && (limited.error.retryAfterMs || 0) > maxWaitMs) {
      aborted = `rate limit with retry-after ${Math.round(limited.error.retryAfterMs / 60000)} min (daily token quota?) at case ${caseId}`;
      if (!error) error = { kind: 'incomplete', message: `stopped on rate limit before the case finished: ${describe()}` };
      break;
    }
    if (!error) error = { kind: 'llm_error', message: describe() };
    if (n < maxAttempts) await sleep(limited?.error.retryAfterMs || 5000 * n);
  }
  return { live, error, attempts, aborted };
}

module.exports = { runAttempts, isCompleteObservation };
