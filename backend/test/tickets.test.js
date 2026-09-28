const test = require('node:test');
const assert = require('node:assert/strict');

// A throwaway in-memory database, and no alert channels: nothing leaves the process.
process.env.SQLITE_PATH = ':memory:';
for (const key of ['TURSO_DATABASE_URL', 'STAFF_ALERT_WEBHOOK_URL', 'SMTP_URL', 'STAFF_ALERT_EMAIL']) delete process.env[key];

const { db } = require('../db');
const { createTicketRecord, draftFollowupEmailRecord, escalateTicketRecord, findTicket } = require('../lib/tickets');

const session = n => `00000000-0000-4000-8000-00000000000${n}`;

test('a repeated incident in one conversation reuses the open ticket and only raises its priority', async () => {
  const first = await createTicketRecord({ category: 'maintenance', summary: 'No heat', priority: 'high' }, 'no heat', 'housing', session(1));
  const second = await createTicketRecord({ category: 'maintenance', summary: 'Still no heat', priority: 'urgent' }, 'still no heat', 'housing', session(1));
  const third = await createTicketRecord({ category: 'maintenance', summary: 'no heat again', priority: 'low' }, 'no heat again', 'housing', session(1));
  assert.equal(second.ticketId, first.ticketId);
  assert.equal(third.ticketId, first.ticketId);
  assert.equal(second.reused, true);
  assert.equal((await findTicket(first.ticketId)).priority, 'urgent');
  const { n } = await db.get('SELECT COUNT(*) AS n FROM tickets WHERE session_id = ?', [session(1)]);
  assert.equal(n, 1);
});

test('lease reviews are tracked separately from chat incidents', async () => {
  const chat = await createTicketRecord({ category: 'maintenance', priority: 'normal' }, 'leak', 'housing', session(2));
  const lease = await createTicketRecord({ category: 'lease_review', priority: 'normal' }, 'clauses', 'housing', session(2), { leaseReview: true });
  assert.notEqual(chat.ticketId, lease.ticketId);
});

test('model-written arguments are clamped to known values', async () => {
  const created = await createTicketRecord({ category: '<script>x</script>', summary: 'a'.repeat(5000), priority: 'CRITICAL!!' }, 'm', 'housing', session(3));
  const ticket = await findTicket(created.ticketId);
  assert.equal(ticket.priority, 'normal');
  assert.doesNotMatch(ticket.category, /[<>]/);
  assert.ok(ticket.summary.length <= 500);
});

test('a ticket can only be escalated or emailed about from its own conversation', async () => {
  const { ticketId } = await createTicketRecord({ category: 'harassment', priority: 'high' }, 'm', 'housing', session(4));
  assert.match((await escalateTicketRecord({ ticketId, reason: 'x' }, session(5))).error, /No ticket/);
  assert.match((await draftFollowupEmailRecord({ ticketId, office: 'wusa', subject: 's', body: 'b' }, session(5))).error, /No ticket/);
  assert.equal((await findTicket(ticketId)).escalated, 0);

  const escalated = await escalateTicketRecord({ ticketId, reason: 'x' }, session(4));
  assert.equal(escalated.escalated, true);
  assert.equal(escalated.staffAlerted, false); // no alert channel configured
  assert.equal((await escalateTicketRecord({ ticketId, reason: 'again' }, session(4))).alreadyEscalated, true);
});

test('follow-up drafts go to a named office, never a model-chosen address', async () => {
  const { ticketId } = await createTicketRecord({ category: 'maintenance', priority: 'normal' }, 'm', 'housing', session(6));
  assert.match((await draftFollowupEmailRecord({ ticketId, office: 'attacker@evil.example', subject: 's', body: 'b' }, session(6))).error, /Unknown office/);
  const ok = await draftFollowupEmailRecord({ ticketId, office: 'off_campus_housing', subject: 's', body: 'b' }, session(6));
  assert.equal(ok.office, 'UW Off-Campus Housing');
  const emails = JSON.parse((await findTicket(ticketId)).emails_json);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, undefined);
  assert.match(emails[0].status, /draft/);
});
