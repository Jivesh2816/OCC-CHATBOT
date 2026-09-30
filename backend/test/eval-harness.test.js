// The eval's measurement tools: detecting malformed model output, and the
// fabrication scan over answers. Both feed reported metrics.
process.env.SQLITE_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inspectOutput, stageOf } = require('../eval/lib/llm-recorder');
const { scanAnswer } = require('../eval/lib/fabrication');
const { summarize } = require('../eval/lib/summarize');

const opts = { validIntents: ['housing', 'urgent'], toolNames: ['create_ticket', 'escalate_ticket'] };

test('router output that is not valid JSON or names an unknown intent is malformed', () => {
  assert.deepEqual(inspectOutput('router', { content: '{"intent":"housing","confidence":0.9}' }, opts), []);
  assert.match(inspectOutput('router', { content: '' }, opts)[0], /invalid JSON/);
  assert.match(inspectOutput('router', { content: '{"intent":"landlord"}' }, opts)[0], /unknown intent/);
});

test('tool calls to unknown tools or with unparseable arguments are flagged', () => {
  const call = (name, args) => ({ function: { name, arguments: args } });
  assert.deepEqual(inspectOutput('action', { tool_calls: [call('create_ticket', '{"priority":"high"}')] }, opts), []);
  const problems = inspectOutput('action', { tool_calls: [call('send_email', '{}'), call('create_ticket', '{oops'), call('escalate_ticket', '[1]')] }, opts);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /hallucinated tool "send_email"/);
  assert.match(problems[1], /unparseable/);
  assert.match(problems[2], /non-object/);
});

test('requests are attributed to the right pipeline stage', () => {
  assert.equal(stageOf({ tools: [], messages: [] }), 'action');
  assert.equal(stageOf({ response_format: { type: 'json_object' }, messages: [{ content: 'You are an intent router for …' }] }), 'router');
  assert.equal(stageOf({ response_format: { type: 'json_object' }, messages: [{ content: 'Lease checker' }] }), 'json');
  assert.equal(stageOf({ messages: [{ content: 'You are a helpful assistant' }] }), 'answer');
});

test('fabrication scan accepts specifics from the knowledge base or the student, flags the rest', () => {
  const clean = scanAnswer('Call the LTB at 1-888-332-3234; the 2027 guideline is 1.9%. Use Form N9. See ontario.ca.');
  assert.deepEqual(clean.unsupported, []);
  assert.ok(clean.checked >= 4);

  const invented = scanAnswer('Email housing-help@uwaterloo.ca or call 519-555-0199. File Form T6 with the board. The fee is $475.');
  const types = invented.unsupported.map(u => u.type).sort();
  assert.deepEqual(types, ['dollars', 'email', 'form', 'phone']);

  // Repeating the student's own figure isn't fabrication.
  assert.deepEqual(scanAnswer('A $600 damage deposit is not allowed.', { userText: 'he charged me $600' }).unsupported, []);
});

test('cases whose model calls failed are excluded from quality metrics and counted as errors', () => {
  const offline = { retrieval: { goldIntent: { faqIds: [], sourceIds: [], faqScores: [], sourceScores: [], ms: 1 }, ungated: { faqIds: [], sourceIds: [], ms: 1 } }, rules: { crisis: null, escalates: false, ms: 0 } };
  const base = { expected_source_ids: [], acceptable_intents: [], acceptable_crisis: [], setup: [], retrieval_should_be_empty: false, expected_crisis: null, should_escalate: false, expected_tool: null, difficulty: 'easy' };
  const casesById = {
    a: { ...base, id: 'a', category: 'info_housing', query: 'q1', expected_intent: 'housing' },
    b: { ...base, id: 'b', category: 'info_housing', query: 'q2', expected_intent: 'housing' }
  };
  const live = intent => ({ router: { intent, confidence: 0.9, ms: 5 }, finalIntent: intent, retrievalEndToEnd: { faqIds: [], sourceIds: [] }, systemEscalates: false, llm: [{ stage: 'router', ms: 5, usage: { input: 1, output: 1 }, error: null, malformed: [] }] });
  const results = summarize({
    meta: { mode: 'router' },
    casesById,
    records: [
      { id: 'a', offline, attempts: 1, error: null, live: live('housing') },
      { id: 'b', offline, attempts: 3, error: { kind: 'llm_error', message: '429' }, live: live(null) }
    ]
  });
  assert.equal(results.metrics.routing.n, 1);
  assert.equal(results.metrics.routing.accuracy, 1);
  assert.equal(results.metrics.reliability.casesErrored, 1);
  assert.equal(results.failures.errors[0].id, 'b');
});
