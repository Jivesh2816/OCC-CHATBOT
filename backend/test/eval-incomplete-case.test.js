// A live case interrupted by the provider is not an observation. The exact
// failure seen in a real run: the action agent's first turn called
// create_ticket, the second turn got a 429 with a long retry-after (the daily
// quota), the agent returned its partial work, and the harness cached and
// scored it as the model choosing "ticket only". Here the real agent, the
// eval's recorder, cache and summarizer run against a scripted model.
const fake = require('./helpers/fake-groq');
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.EVAL_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cache-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { groq } = require('../lib/llm');
const { actionAgent } = require('../pipeline/action');
const { instrument } = require('../eval/lib/llm-recorder');
const { runAttempts, isCompleteObservation } = require('../eval/lib/attempts');
const cache = require('../eval/lib/cache');
const { summarize } = require('../eval/lib/summarize');
const { normalize, TOOL_NAMES } = require('../eval/lib/dataset');

const rateLimited = retryAfterSeconds => {
  const error = fake.apiError(429, 'Rate limit reached');
  error.headers = { 'retry-after': String(retryAfterSeconds) };
  return error;
};

// Turn 1: create_ticket succeeds. Turn 2: the provider fails with `failure`.
function scriptTicketThen(failure) {
  fake.install((stage, params, n) => {
    if (n === 0) return fake.message(null, [fake.toolCall('create_ticket', { category: 'maintenance', summary: 'neighbour threats', priority: 'high' })]);
    throw failure();
  });
  return instrument(groq, { tokensPerMinute: 1e9, validIntents: [], toolNames: TOOL_NAMES });
}

// The same live record shape eval/run.js builds for agent mode.
const agentAttempt = (recorder, query) => async () => {
  recorder.calls = [];
  const out = await actionAgent(query, 'housing', null, crypto.randomUUID());
  return {
    intent: 'housing',
    tools: out.actionsTaken.map(a => ({ tool: a.tool, args: a.args, error: a.result?.error || null, priority: a.args?.priority || null })),
    rawToolCalls: [],
    modelTurns: recorder.calls.filter(call => call.stage === 'action').length,
    agentError: out.error || null,
    tickets: [],
    llm: recorder.calls.slice()
  };
};

// The fields the summarizer reads that normalize() leaves to the dataset file.
const labeled = fields => normalize({ expected_source_ids: [], expected_crisis: null, should_escalate: null, difficulty: 'easy', ...fields });
const c = labeled({ id: 'tool-neighbour-threatening', category: 'tool_incident', query: 'my neighbour keeps threatening me', expected_intent: 'housing', expected_tool: 'escalate_ticket' });

test('a 429 on the second tool-loop turn (daily quota) marks the case incomplete: not cached, not scored, re-run on --resume', async () => {
  const recorder = scriptTicketThen(() => rateLimited(600));
  const slept = [];
  const run = await runAttempts({ caseId: c.id, maxAttempts: 3, maxWaitMs: 5 * 60_000, sleep: async ms => slept.push(ms), attempt: agentAttempt(recorder, c.query) });
  recorder.restore();

  // Stopped on the quota, without retrying, and the case is marked incomplete.
  assert.match(run.aborted, /retry-after 10 min .* at case tool-neighbour-threatening/);
  assert.equal(run.attempts, 1);
  assert.deepEqual(slept, []);
  assert.equal(run.error.kind, 'incomplete');
  // The partial work is kept for debugging...
  assert.deepEqual(run.live.tools.map(t => t.tool), ['create_ticket']);
  assert.equal(run.live.llm.at(-1).error.status, 429);
  // ...but it is not a completed observation, so the harness won't cache it.
  const record = { id: c.id, attempts: run.attempts, ...run };
  assert.equal(isCompleteObservation(record), false);

  // Excluded from accuracy: only the completed case is scored.
  const offline = { retrieval: { goldIntent: { faqIds: [], sourceIds: [], faqScores: [], sourceScores: [], ms: 1 }, ungated: { faqIds: [], sourceIds: [], ms: 1 } }, rules: { crisis: null, escalates: false, ms: 0 } };
  const done = labeled({ id: 'done', category: 'tool_incident', query: 'no heat in January', expected_intent: 'housing', expected_tool: 'escalate_ticket' });
  const completedLive = { intent: 'housing', tools: [{ tool: 'create_ticket', args: {}, error: null, priority: 'high' }, { tool: 'escalate_ticket', args: {}, error: null, priority: null }], rawToolCalls: [], modelTurns: 2, tickets: [], llm: [{ stage: 'action', ms: 5, usage: { input: 1, output: 1 }, error: null, malformed: [] }] };
  const results = summarize({
    meta: { mode: 'agent' },
    casesById: { [c.id]: c, done },
    records: [{ id: 'done', offline, attempts: 1, error: null, live: completedLive }, { ...record, offline }]
  });
  assert.equal(results.metrics.agentTools.n, 1);
  assert.equal(results.metrics.agentTools.accuracy, 1);
  assert.equal(results.metrics.agentTools.levelConfusion.matrix.escalate.create, 0);
  assert.equal(results.metrics.agentTools.perTool.create_ticket.called, 1);

  // Eligible for --resume: even if an older harness cached it, it is never reused.
  const fp = cache.configFingerprint('agent', { model: 'm', prompts: [] });
  cache.appendCache('agent', { id: c.id, fingerprint: fp, caseHash: cache.caseInputHash('agent', c), recordedAt: 't', attempts: 1, live: run.live });
  assert.equal(cache.lookup(cache.loadCache('agent'), c, 'agent', fp).status, 'miss');
});

test('a provider failure mid tool loop that persists through retries is an error, not an observation', async () => {
  for (const failure of [() => rateLimited(1), () => fake.apiError(503, 'Service unavailable'), () => fake.apiError(undefined, 'socket hang up')]) {
    const recorder = scriptTicketThen(failure);
    const slept = [];
    const run = await runAttempts({ caseId: c.id, maxAttempts: 3, maxWaitMs: 5 * 60_000, sleep: async ms => slept.push(ms), attempt: agentAttempt(recorder, c.query) });
    recorder.restore();
    assert.equal(run.aborted, null);
    assert.equal(run.attempts, 3);
    assert.equal(slept.length, 2);
    assert.equal(run.error.kind, 'llm_error');
    assert.equal(isCompleteObservation({ ...run }), false);
  }
});

test('a tool loop that completes is a completed observation', async () => {
  fake.install((stage, params, n) => (n === 0 ? fake.message(null, [fake.toolCall('create_ticket', { category: 'maintenance', summary: 's', priority: 'normal' })]) : fake.message('done')));
  const recorder = instrument(groq, { tokensPerMinute: 1e9, validIntents: [], toolNames: TOOL_NAMES });
  const run = await runAttempts({ caseId: c.id, maxAttempts: 3, maxWaitMs: 5 * 60_000, sleep: async () => {}, attempt: agentAttempt(recorder, c.query) });
  recorder.restore();
  assert.equal(run.error, null);
  assert.equal(run.aborted, null);
  assert.equal(isCompleteObservation({ ...run }), true);
});
