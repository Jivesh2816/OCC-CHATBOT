// The four kinds of invalid tool call are counted separately and once each.
// The provider-rejected kind is the one a real run hit and the old metric
// missed: Groq refused the model's generation with a 400 tool_use_failed, the
// app never saw a call, and the pipeline reported "invalid/hallucinated 0".
const fake = require('./helpers/fake-groq');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { groq } = require('../lib/llm');
const { actionAgent } = require('../pipeline/action');
const { instrument } = require('../eval/lib/llm-recorder');
const { isCompleteObservation } = require('../eval/lib/attempts');
const { classifyToolCalls, summarizeToolCalls } = require('../eval/lib/tool-calls');
const { TOOL_NAMES } = require('../eval/lib/dataset');

// What Groq returns when the model's tool-call JSON doesn't parse.
const toolUseFailed = () => {
  const error = fake.apiError(400, '{"error":{"message":"Failed to parse tool call arguments as JSON","type":"invalid_request_error","code":"tool_use_failed","failed_generation":"{\\"name\\": \\"create_ticket\\", \\"arguments\\": {\\n  \\"c"}}');
  return error;
};

async function runAgent(handler) {
  fake.install(handler);
  const recorder = instrument(groq, { tokensPerMinute: 1e9, validIntents: [], toolNames: TOOL_NAMES });
  const out = await actionAgent('my roommate has not paid the internet for three months', 'housing', null, crypto.randomUUID());
  recorder.restore();
  return { out, llm: recorder.calls.slice(), executed: out.actionsTaken.map(a => ({ tool: a.tool, error: a.result?.error || null })) };
}

test('a provider-rejected tool call is counted as provider-rejected, not hallucinated or malformed, and the case still counts as completed', async () => {
  const { out, llm, executed } = await runAgent(() => { throw toolUseFailed(); });
  assert.equal(out.actionsTaken.length, 0);
  const p = classifyToolCalls(llm, executed);
  assert.equal(p.providerRejected.length, 1);
  assert.equal(p.providerRejected[0].tool, 'create_ticket');
  assert.equal(p.hallucinated.length, 0);
  assert.equal(p.malformedArguments.length, 0);
  const q = summarizeToolCalls([p]);
  assert.equal(q.attemptedCalls, 1);
  assert.equal(q.invalidCallRate, 1);
  // A 400 is the model's own output failing, so it is scored, not retried away.
  assert.equal(isCompleteObservation({ live: { llm }, error: null }), true);
});

test('hallucinated tools, malformed arguments and server-side rejections are each counted once, in their own kind', async () => {
  const { llm, executed } = await runAgent((stage, params, n) => {
    if (n === 0) return fake.message(null, [fake.toolCall('send_sms', { to: '555' }), fake.toolCall('create_ticket', { category: 'x', summary: 's', priority: 'CRITICAL' })]);
    if (n === 1) return fake.message(null, [fake.toolCall('draft_followup_email', { ticketId: 'T-nope', office: 'off_campus_housing', subject: 's', body: 'b' })]);
    return fake.message('done');
  });
  const p = classifyToolCalls(llm, executed);
  assert.deepEqual(p.hallucinated.map(x => x.tool), ['send_sms']);
  assert.deepEqual(p.malformedArguments.map(x => x.tool), ['create_ticket']);
  assert.match(p.malformedArguments[0].why, /priority/);
  // The app refused a well-formed draft for a ticket that doesn't exist. The
  // hallucinated send_sms also got an "Unknown tool" error back, but isn't counted twice.
  assert.deepEqual(p.serverRejected.map(x => x.tool), ['draft_followup_email']);
  assert.equal(p.providerRejected.length, 0);
  const q = summarizeToolCalls([p]);
  assert.equal(q.rawToolCalls, 3);
  assert.equal(q.counts.hallucinated + q.counts.malformedArguments + q.counts.providerRejected, 2);
  assert.equal(q.invalidCallRate, 0.6667);
});

test('router JSON rejections and rate limits are not tool-call problems', () => {
  const llm = [
    { stage: 'router', error: { status: 400, message: 'Failed to validate JSON' }, malformed: [] },
    { stage: 'action', error: { status: 429, message: 'Rate limit reached' }, malformed: [] },
    { stage: 'action', error: null, malformed: [], toolCalls: [{ name: 'create_ticket', arguments: JSON.stringify({ category: 'maintenance', summary: 's', priority: 'normal' }) }] }
  ];
  const p = classifyToolCalls(llm, [{ tool: 'create_ticket', error: null }]);
  assert.deepEqual([p.hallucinated.length, p.malformedArguments.length, p.providerRejected.length, p.serverRejected.length], [0, 0, 0, 0]);
  assert.equal(summarizeToolCalls([p]).invalidCallRate, 0);
});
