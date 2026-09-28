const test = require('node:test');
const assert = require('node:assert/strict');
const { preCheck, postCheck } = require('../lib/critic');

test('pre-check overrides a non-urgent router intent on a safety phrase', () => {
  const result = preCheck("my roommate hit me last night and I don't feel safe", 'housing');
  assert.equal(result.intent, 'urgent');
  assert.match(result.override, /critic overrode to urgent/);
});

test('pre-check leaves ordinary messages and already-urgent intents alone', () => {
  assert.deepEqual(preCheck('How do I sublet my room?', 'housing'), { intent: 'housing', override: null });
  assert.deepEqual(preCheck('I want to die', 'urgent'), { intent: 'urgent', override: null });
});

test('pre-check still fires when the router failed entirely', () => {
  assert.equal(preCheck('I am in danger', null).intent, 'urgent');
});

const base = { intent: 'housing', routerConfidence: 0.9, matchType: 'faq', botResponse: 'Here is some help.', actionsTaken: [], preCheckOverride: null };

test('post-check raises no flags on a confident, grounded answer', () => {
  const result = postCheck(base);
  assert.deepEqual(result.flags, { safetyOverride: false, lowConfidence: false, policySensitive: false, escalationOverride: false });
  assert.equal(result.response, base.botResponse);
  assert.deepEqual(result.escalate, []);
  assert.equal(result.createUrgent, false);
});

test('post-check flags low router confidence and fallback answers', () => {
  assert.equal(postCheck({ ...base, routerConfidence: 0.3 }).flags.lowConfidence, true);
  assert.equal(postCheck({ ...base, matchType: 'fallback' }).flags.lowConfidence, true);
  assert.equal(postCheck({ ...base, matchType: 'official' }).flags.lowConfidence, false);
});

test('post-check appends a disclaimer to legal-advice phrasing', () => {
  const result = postCheck({ ...base, botResponse: 'You could file at the Landlord and Tenant Board.' });
  assert.equal(result.flags.policySensitive, true);
  assert.match(result.response, /not legal advice/);
});

test('post-check force-escalates a high-priority ticket the agent left unescalated', () => {
  const actionsTaken = [{ tool: 'create_ticket', args: { priority: 'high' }, result: { ticketId: 'T-1' } }];
  const result = postCheck({ ...base, actionsTaken });
  assert.deepEqual(result.escalate, ['T-1']);
  assert.equal(result.flags.escalationOverride, true);
});

test('post-check does not re-escalate a ticket the agent already escalated', () => {
  const actionsTaken = [
    { tool: 'create_ticket', args: { priority: 'urgent' }, result: { ticketId: 'T-2' } },
    { tool: 'escalate_ticket', args: { ticketId: 'T-2' }, result: { escalated: true } }
  ];
  assert.deepEqual(postCheck({ ...base, actionsTaken }).escalate, []);
});

test('post-check ignores normal/low priority tickets', () => {
  const actionsTaken = [{ tool: 'create_ticket', args: { priority: 'normal' }, result: { ticketId: 'T-3' } }];
  assert.deepEqual(postCheck({ ...base, actionsTaken }).escalate, []);
});

test('post-check opens a ticket for an urgent message when the agent created none', () => {
  const result = postCheck({ ...base, intent: 'urgent', matchType: 'escalation' });
  assert.equal(result.createUrgent, true);
  assert.equal(result.flags.escalationOverride, true);
});

test('post-check does not open a duplicate when an urgent ticket already exists', () => {
  const actionsTaken = [
    { tool: 'create_ticket', args: { priority: 'urgent' }, result: { ticketId: 'T-4' } },
    { tool: 'escalate_ticket', args: { ticketId: 'T-4' }, result: { escalated: true } }
  ];
  const result = postCheck({ ...base, intent: 'urgent', actionsTaken });
  assert.equal(result.createUrgent, false);
  assert.equal(result.flags.escalationOverride, false);
});
