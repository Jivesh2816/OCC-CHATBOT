// The eval dataset must stay consistent with the code it labels: real
// intents, passage/FAQ ids that still exist after a re-scrape, real crisis
// categories and tool names. Coverage checks keep every class measurable.
process.env.SQLITE_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDataset, validateCases, normalize, CRISIS_IDS, requiredTools, primaryTool } = require('../eval/lib/dataset');
const { summarize } = require('../eval/lib/summarize');
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
    { ...good, id: 'bad-ticket', expected_actions: { ticket: 'urgent', draft: null } },
    { ...good, id: 'draft-without-ticket', expected_actions: { ticket: 'none', draft: true } },
    { ...good, id: 'legacy-label', expected_tool: 'create_ticket' },
    { ...good, id: 'bad-crisis', expected_crisis: 'panic', should_escalate: true },
    { ...good, id: 'contradiction', expected_crisis: 'self_harm', should_escalate: false },
    { ...good, id: 'bad-source' }
  ]);
  for (const fragment of ['unknown intent', 'unknown source id', 'ticket must be one of', 'ticket "none" requires draft false', 'is replaced by expected_actions', 'unknown crisis id', 'must not be should_escalate=false', 'duplicate id']) {
    assert.ok(problems.some(p => p.includes(fragment)), `expected a "${fragment}" problem in ${JSON.stringify(problems)}`);
  }
});

test('every intent, crisis category and tool is covered by labeled cases', () => {
  const n = cases.map(normalize);
  for (const intent of VALID_INTENTS) assert.ok(n.filter(c => c.expected_intent === intent).length >= 5, `intent ${intent} has fewer than 5 cases`);
  for (const id of CRISIS_IDS) assert.ok(n.some(c => c.expected_crisis === id), `no case for crisis ${id}`);
  for (const level of ['none', 'create', 'escalate']) assert.ok(n.some(c => c.expected_actions?.ticket === level), `no case expecting ticket level ${level}`);
  for (const draft of [true, false, null]) assert.ok(n.some(c => c.expected_actions && c.expected_actions.draft === draft), `no case with draft ${draft}`);
  assert.ok(n.filter(c => c.category === 'safety_hard_negative').length >= 15);
  assert.ok(n.filter(c => c.should_escalate === true).length >= 20);
});

test('multi-action labels: required tools, and the pipeline\'s single-tool check', () => {
  assert.deepEqual(requiredTools({ ticket: 'none', draft: false }), []);
  assert.deepEqual(requiredTools({ ticket: 'escalate', draft: true }), ['create_ticket', 'escalate_ticket', 'draft_followup_email']);
  assert.deepEqual(requiredTools({ ticket: 'create', draft: null }), ['create_ticket']);
  assert.equal(primaryTool({ ticket: 'escalate', draft: null }), 'escalate_ticket');
  assert.equal(primaryTool({ ticket: 'create', draft: true }), 'draft_followup_email');
});

test('agent scoring: draft true requires a draft, false forbids one, null ignores it; over-escalation is counted', () => {
  const offline = { retrieval: { goldIntent: { faqIds: [], sourceIds: [], faqScores: [], sourceScores: [], ms: 1 }, ungated: { faqIds: [], sourceIds: [], ms: 1 } }, rules: { crisis: null, escalates: false, ms: 0 } };
  const base = { category: 'tool_incident', difficulty: 'easy', expected_intent: 'housing', expected_source_ids: [], expected_crisis: null, should_escalate: null };
  const mk = (id, expected_actions, tools, acceptable_actions = []) => ({
    c: normalize({ ...base, id, query: id, expected_actions, acceptable_actions }),
    r: { id, offline, attempts: 1, error: null, live: { intent: 'housing', tools: tools.map(tool => ({ tool, args: {}, error: null })), rawToolCalls: [], modelTurns: 1, tickets: [], totalMs: 1, llm: [] } }
  });
  const rows = [
    mk('draft-required-missing', { ticket: 'create', draft: true }, ['create_ticket']),
    mk('draft-silent', { ticket: 'create', draft: null }, ['create_ticket', 'draft_followup_email']),
    mk('draft-forbidden', { ticket: 'create', draft: false }, ['create_ticket', 'draft_followup_email']),
    mk('over-escalated', { ticket: 'create', draft: null }, ['create_ticket', 'escalate_ticket']),
    mk('escalation-acceptable', { ticket: 'create', draft: null }, ['create_ticket', 'escalate_ticket'], [{ ticket: 'escalate', draft: null }]),
    mk('under-escalated', { ticket: 'escalate', draft: null }, ['create_ticket'])
  ];
  const t = summarize({ meta: { mode: 'agent' }, casesById: Object.fromEntries(rows.map(x => [x.c.id, x.c])), records: rows.map(x => x.r) }).metrics.agentTools;
  // Correct: draft-silent (a draft the label is silent on is not an error) and escalation-acceptable.
  assert.equal(t.accuracy, round2(2 / 6));
  assert.deepEqual(t.escalation, { ticketOnlyCases: 4, ticketOnlyEscalated: 1, escalateCases: 1, escalateDowngraded: 1 });
  // Draft precision is over cases whose label specifies drafting; the silent one is reported, not scored.
  assert.equal(t.perTool.draft_followup_email.calledWhereLabelSilent, 1);
  assert.equal(t.perTool.draft_followup_email.precision, 0);
  assert.equal(t.perTool.draft_followup_email.recall, 0);
});

const round2 = x => Math.round(x * 10000) / 10000;
