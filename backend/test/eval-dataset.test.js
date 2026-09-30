// The eval dataset must stay consistent with the code it labels: real
// intents, passage/FAQ ids that still exist after a re-scrape, real crisis
// categories and tool names. Coverage checks keep every class measurable.
process.env.SQLITE_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDataset, validateCases, normalize, TOOL_NAMES, CRISIS_IDS } = require('../eval/lib/dataset');
const { VALID_INTENTS } = require('../pipeline/router');
const { allFAQs } = require('../lib/knowledge');

const { cases } = loadDataset();

test('the dataset validates against the live code', () => {
  assert.ok(cases.length >= 150, `only ${cases.length} cases`);
});

test('every FAQ has a unique, stable id', () => {
  const ids = allFAQs().map(f => f.id);
  assert.ok(ids.every(id => /^faq-[a-z0-9-]+$/.test(id)));
  assert.equal(new Set(ids).size, ids.length);
});

test('the validator rejects labels that do not match the system', () => {
  const good = cases[0];
  const problems = validateCases([
    { ...good, id: 'bad-intent', expected_intent: 'housingg' },
    { ...good, id: 'bad-source', expected_source_ids: ['know-your-rights-999'] },
    { ...good, id: 'bad-tool', expected_tool: 'send_email' },
    { ...good, id: 'bad-crisis', expected_crisis: 'panic', should_escalate: true },
    { ...good, id: 'contradiction', expected_crisis: 'self_harm', should_escalate: false },
    { ...good, id: 'bad-source' }
  ]);
  for (const fragment of ['unknown intent', 'unknown source id', 'unknown tool', 'unknown crisis id', 'must not be should_escalate=false', 'duplicate id']) {
    assert.ok(problems.some(p => p.includes(fragment)), `expected a "${fragment}" problem in ${JSON.stringify(problems)}`);
  }
});

test('every intent, crisis category and tool is covered by labeled cases', () => {
  const n = cases.map(normalize);
  for (const intent of VALID_INTENTS) assert.ok(n.filter(c => c.expected_intent === intent).length >= 5, `intent ${intent} has fewer than 5 cases`);
  for (const id of CRISIS_IDS) assert.ok(n.some(c => c.expected_crisis === id), `no case for crisis ${id}`);
  for (const tool of [...TOOL_NAMES, 'none']) assert.ok(n.some(c => c.expected_tool === tool), `no case expecting ${tool}`);
  assert.ok(n.filter(c => c.category === 'safety_hard_negative').length >= 15);
  assert.ok(n.filter(c => c.should_escalate === true).length >= 20);
});
