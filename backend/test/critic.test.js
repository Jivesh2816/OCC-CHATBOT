const test = require('node:test');
const assert = require('node:assert/strict');
const { preCheck, postCheck } = require('../lib/critic');

test('pre-check overrides a non-urgent router intent on a safety phrase', () => {
  const result = preCheck("my roommate hit me last night and I don't feel safe", 'housing');
  assert.equal(result.intent, 'urgent');
  assert.match(result.override, /critic overrode to urgent/);
});

test('pre-check leaves ordinary messages and already-urgent intents alone', () => {
  assert.deepEqual(preCheck('How do I sublet my room?', 'housing'), { intent: 'housing', crisis: null, override: null });
  const alreadyUrgent = preCheck('I want to die', 'urgent');
  assert.equal(alreadyUrgent.intent, 'urgent');
  assert.equal(alreadyUrgent.override, null);
  assert.equal(alreadyUrgent.crisis.id, 'self_harm');
});

test('pre-check still fires when the router failed entirely', () => {
  assert.equal(preCheck('I am in danger', null).intent, 'urgent');
  assert.equal(preCheck('my boyfriend hits me and im scared to go home', null).intent, 'urgent');
});

test('pre-check sends a housing emergency to housing when the router failed', () => {
  const result = preCheck('my landlord changed the locks and I have nowhere to sleep', null);
  assert.equal(result.intent, 'housing');
  assert.equal(result.crisis.id, 'housing_emergency');
});

const base = { intent: 'housing', routerConfidence: 0.9, matchType: 'faq', botResponse: 'Here is some help.', actionsTaken: [], preCheckOverride: null };

test('post-check raises no flags on a confident, grounded answer', () => {
  const result = postCheck(base);
  assert.deepEqual(result.flags, { safetyOverride: false, lowConfidence: false, policySensitive: false, escalationOverride: false, uncited: false, crisisResources: false });
  assert.equal(result.response, base.botResponse);
  assert.deepEqual(result.escalate, []);
  assert.equal(result.ensureTicket, null);
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

test('any answer about what tenancy law allows gets the disclaimer', () => {
  // The lockout answer in live testing said "Landlord-Tenant Board" and
  // "illegal" and slipped past the old phrase list.
  for (const text of ['Contact the Ontario Landlord-Tenant Board.', 'That is an illegal lockout.', 'Under the Residential Tenancies Act, heat is required.', 'Call the LTB.']) {
    assert.equal(postCheck({ ...base, botResponse: text }).flags.policySensitive, true, text);
  }
  assert.equal(postCheck({ ...base, botResponse: 'Buy in bulk to save money.' }).flags.policySensitive, false);
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
  assert.deepEqual(result.ensureTicket, { priority: 'urgent' });
  assert.equal(result.flags.escalationOverride, true);
});

test('post-check does not open a duplicate when an urgent ticket already exists', () => {
  const actionsTaken = [
    { tool: 'create_ticket', args: { priority: 'urgent' }, result: { ticketId: 'T-4' } },
    { tool: 'escalate_ticket', args: { ticketId: 'T-4' }, result: { escalated: true } }
  ];
  const result = postCheck({ ...base, intent: 'urgent', actionsTaken });
  assert.equal(result.ensureTicket, null);
  assert.equal(result.flags.escalationOverride, false);
});

const passages = cited => [
  { n: 1, id: 'know-your-rights-5', cited },
  { n: 2, id: 'guide-ontarios-standard-lease-20', cited: false }
];

test('flags an official-only answer that cites none of its passages, and says so', () => {
  const result = postCheck({ ...base, matchType: 'official', citations: passages(false) });
  assert.equal(result.flags.uncited, true);
  assert.match(result.response, /couldn't tie this answer to a specific official source/);
});

test('does not flag an official answer that cites a passage', () => {
  const result = postCheck({ ...base, matchType: 'official', citations: passages(true) });
  assert.equal(result.flags.uncited, false);
  assert.equal(result.response, base.botResponse);
});

test('an FAQ match does not excuse ignoring the official passages it came with', () => {
  // FAQs carry no legal specifics, so an uncited notice period or percentage
  // next to unused official passages still gets the caution note.
  assert.equal(postCheck({ ...base, matchType: 'faq', citations: passages(false) }).flags.uncited, true);
  assert.equal(postCheck({ ...base, matchType: 'faq', citations: [] }).flags.uncited, false);
});

test('a housing emergency keeps its answer, adds resources, and makes sure a person hears about it', () => {
  const crisis = { id: 'housing_emergency', label: 'losing housing', urgent: false, match: 'changed the locks' };
  const result = postCheck({ ...base, crisis });
  assert.ok(result.response.startsWith(base.botResponse));
  assert.match(result.response, /2-1-1/);
  assert.equal(result.flags.crisisResources, true);
  assert.deepEqual(result.ensureTicket, { priority: 'high' });
});

test('a housing emergency the agent already ticketed is not ticketed again', () => {
  const crisis = { id: 'housing_emergency', label: 'losing housing', urgent: false, match: 'changed the locks' };
  const actionsTaken = [{ tool: 'create_ticket', args: { priority: 'high' }, result: { ticketId: 'T-5', priority: 'high' } }];
  const result = postCheck({ ...base, crisis, actionsTaken });
  assert.equal(result.ensureTicket, null);
  assert.deepEqual(result.escalate, ['T-5']);
});
