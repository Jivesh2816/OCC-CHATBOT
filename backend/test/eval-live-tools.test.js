// The eval's live-run plumbing: tool-argument schema checks, the resumable
// cache's validity rules, and the deterministic groundedness checks.
const path = require('path');
const os = require('os');
const fs = require('fs');
process.env.SQLITE_PATH = ':memory:';
process.env.EVAL_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-cache-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateToolCall } = require('../eval/lib/tool-schema');
const cache = require('../eval/lib/cache');
const { groundedness } = require('../eval/lib/groundedness');
const { normalize } = require('../eval/lib/dataset');

test('tool calls are checked against the agent\'s own schemas', () => {
  assert.deepEqual(validateToolCall('create_ticket', JSON.stringify({ category: 'maintenance', summary: 'No heat', priority: 'high' })), []);
  assert.deepEqual(validateToolCall('send_sms', '{}'), ['unknown tool "send_sms"']);
  assert.deepEqual(validateToolCall('create_ticket', '{oops'), ['arguments are not valid JSON']);
  const problems = validateToolCall('create_ticket', JSON.stringify({ category: 'x', priority: 'CRITICAL', to: 'a@b.c' }));
  assert.ok(problems.some(p => p.includes('missing required "summary"')));
  assert.ok(problems.some(p => p.includes('"priority"="CRITICAL"')));
  assert.ok(problems.some(p => p.includes('unexpected argument "to"')));
  assert.ok(validateToolCall('draft_followup_email', JSON.stringify({ ticketId: 'T-1', office: 'landlord@evil.example', subject: 's', body: 'b' }))[0].includes('office'));
});

test('cached live results are reused only for the same configuration and case inputs', () => {
  const c = normalize({ id: 'x', query: 'my heater is broken', expected_intent: 'housing' });
  const fp = cache.configFingerprint('agent', { model: 'm1', prompts: [] });
  cache.appendCache('agent', { id: 'x', fingerprint: fp, caseHash: cache.caseInputHash('agent', c), recordedAt: 't', live: { ok: 1 } });
  const loaded = cache.loadCache('agent');
  assert.equal(cache.lookup(loaded, c, 'agent', fp).status, 'fresh');
  // A different model is a different configuration.
  assert.equal(cache.lookup(loaded, c, 'agent', cache.configFingerprint('agent', { model: 'm2', prompts: [] })).status, 'stale');
  // Editing the case's query invalidates it; relabeling it doesn't.
  assert.equal(cache.lookup(loaded, { ...c, query: 'my heater is fine' }, 'agent', fp).status, 'stale');
  assert.equal(cache.lookup(loaded, { ...c, expected_actions: { ticket: 'none', draft: false } }, 'agent', fp).status, 'fresh');
  assert.equal(cache.lookup(loaded, normalize({ id: 'y', query: 'q' }), 'agent', fp).status, 'miss');
  // A half-written line from a crash is ignored rather than breaking the run.
  fs.appendFileSync(path.join(process.env.EVAL_CACHE_DIR, 'agent.jsonl'), '{"id":"z","finger');
  assert.equal(cache.loadCache('agent').has('z'), false);
});

test('groundedness flags citations to passages that were never given, and specifics missing from the context', () => {
  const c = normalize({ id: 'g', query: 'Can my landlord enter without notice?', expected_source_ids: ['know-your-rights-5'] });
  const good = groundedness(c, { answer: 'They need 24 hours written notice [1].', retrieved: { sourceIds: ['know-your-rights-5'], faqIds: [] } });
  assert.deepEqual(good.invalidMarkers, []);
  assert.equal(good.citesLabeledSource, true);
  assert.deepEqual(good.contextUnsupported, []);

  const bad = groundedness(c, { answer: 'Call the LTB at 416-645-8080 [3]. UW policy says landlords must knock.', retrieved: { sourceIds: ['know-your-rights-5'], faqIds: [] } });
  assert.deepEqual(bad.invalidMarkers, [3]);
  // In the knowledge base (the standard-lease guide), but not in the passage
  // this answer was given, and not one of the crisis lines the system appends.
  assert.equal(bad.contextUnsupported[0].type, 'phone');
  assert.equal(bad.policyClaimWithoutContext, true);
});

test('uncertainty is recognised in the phrasings the answer prompt asks for', () => {
  const c = normalize({ id: 'u', query: 'late rent penalty amount?', expected_source_ids: [] });
  assert.equal(groundedness(c, { answer: "I don't have specific details on that, so it's best to check with the LTB.", retrieved: {} }).acknowledgesUncertainty, true);
  assert.equal(groundedness(c, { answer: 'The penalty is $50.', retrieved: {} }).acknowledgesUncertainty, false);
});
