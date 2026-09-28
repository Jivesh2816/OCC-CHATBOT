// Ticket records and message history in SQLite (db.js). The action agent's
// tools, the critic, the lease escalation route, and staff routes share these.
//
// The tool functions take arguments written by the model, so everything here
// treats them as untrusted: values are clamped to known sets and lengths, and
// a ticket can only be touched from the session that owns it.
const crypto = require('crypto');
const { db } = require('../db');
const { sendEscalationAlert } = require('./alerts');

const now = () => new Date().toISOString();

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const PRIORITY_RANK = Object.fromEntries(PRIORITIES.map((p, i) => [p, i]));

// Follow-up emails are drafts for staff to review and send, addressed to an
// office by name. The model never supplies an email address: in testing it
// invented plausible-looking ones (counselling@…, legalservices@…) every time.
const OFFICES = {
  off_campus_housing: 'UW Off-Campus Housing',
  campus_wellness: 'UW Campus Wellness',
  special_constable_service: 'UW Special Constable Service',
  wusa: 'WUSA',
  community_legal_services: 'Waterloo Region Community Legal Services'
};

const clip = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

async function findTicket(ticketId) {
  return db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
}

// A ticket the model or a route may act on: it must exist and belong to this session.
async function findOwnedTicket(ticketId, sessionId) {
  const ticket = await findTicket(String(ticketId || ''));
  if (!ticket || ticket.session_id !== sessionId) return null;
  return ticket;
}

// The session's most recent unresolved ticket of the given kind. Lease reviews
// are tracked separately from chat incidents.
async function findOpenTicket(sessionId, { leaseReview = false } = {}) {
  return db.get(
    `SELECT * FROM tickets WHERE session_id = ? AND status != 'resolved' AND ${leaseReview ? "category = 'lease_review'" : "category != 'lease_review'"}
     ORDER BY created_at DESC LIMIT 1`,
    [sessionId]
  );
}

async function recentMessages(sessionId, limit) {
  const rows = await db.all('SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?', [sessionId, limit]);
  return rows.reverse();
}

function formatTicket(row, replies = []) {
  const { emails_json, ...ticket } = row;
  return { ...ticket, escalated: !!ticket.escalated, emails: JSON.parse(emails_json || '[]'), replies };
}

// Opens a ticket, or — when the session already has an unresolved one — adds
// to that ticket instead of creating a duplicate (a student repeating "still
// no heat" three times is one issue, not three alerts). The priority is only
// ever raised, never lowered, and the original summary is kept.
async function createTicketRecord({ category, summary, priority }, message, intent, sessionId, { leaseReview = false } = {}) {
  const safePriority = PRIORITIES.includes(priority) ? priority : 'normal';
  const safeCategory = leaseReview ? 'lease_review' : (clip(category, 40).toLowerCase().replace(/[^a-z0-9_ -]/g, '') || intent || 'general');
  const safeSummary = clip(summary, 500) || clip(message, 500);

  const existing = await findOpenTicket(sessionId, { leaseReview });
  if (existing) {
    const raised = PRIORITY_RANK[safePriority] > (PRIORITY_RANK[existing.priority] ?? 1) ? safePriority : existing.priority;
    // The first summary stays; staff read the full conversation in the dashboard.
    await db.run('UPDATE tickets SET priority = ? WHERE id = ?', [raised, existing.id]);
    console.log('Ticket reused:', existing.id, 'priority', raised);
    return { ticketId: existing.id, status: existing.status, priority: raised, reused: true };
  }

  const id = `T-${crypto.randomUUID().slice(0, 8)}`;
  await db.run(
    `INSERT INTO tickets (id, session_id, category, summary, priority, status, original_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, sessionId, safeCategory, safeSummary, safePriority, 'open', String(message || '').slice(0, 4000), now()]
  );
  console.log('Ticket created:', id, safeCategory, safePriority);
  return { ticketId: id, status: 'open', priority: safePriority };
}

async function draftFollowupEmailRecord({ ticketId, office, subject, body }, sessionId) {
  const ticket = await findOwnedTicket(ticketId, sessionId);
  if (!ticket) return { error: `No ticket ${ticketId} on this conversation` };
  if (!OFFICES[office]) return { error: `Unknown office "${office}". Use one of: ${Object.keys(OFFICES).join(', ')}` };

  const draft = { office: OFFICES[office], subject: clip(subject, 150), body: String(body || '').slice(0, 3000), draftedAt: now(), status: 'draft — staff to review and send' };
  const emails = JSON.parse(ticket.emails_json || '[]');
  if (emails.length >= 3) return { error: 'This ticket already has the maximum number of drafts' };
  emails.push(draft);
  await db.run('UPDATE tickets SET emails_json = ? WHERE id = ?', [JSON.stringify(emails), ticket.id]);
  console.log('Follow-up draft saved on', ticket.id, 'for', draft.office);
  return { ticketId: ticket.id, office: draft.office, draft: true };
}

async function escalateTicketRecord({ ticketId, reason }, sessionId) {
  const ticket = await findOwnedTicket(ticketId, sessionId);
  if (!ticket) return { error: `No ticket ${ticketId} on this conversation` };
  if (ticket.escalated) return { ticketId: ticket.id, status: ticket.status, escalated: true, staffAlerted: false, alreadyEscalated: true };

  // Staff may already be working on it (in_progress); escalating flags it
  // without moving it backwards.
  const status = ticket.status === 'open' ? 'escalated' : ticket.status;
  await db.run('UPDATE tickets SET escalated = 1, status = ?, escalation_reason = ? WHERE id = ?', [status, clip(reason, 300), ticket.id]);
  console.log('Ticket escalated:', ticket.id);

  // Awaited (with a timeout inside) rather than fire-and-forget: a serverless
  // function can be frozen as soon as the response is sent, which would
  // silently drop the alert.
  const alert = await sendEscalationAlert({ ...ticket, escalated: 1 }, reason);
  return { ticketId: ticket.id, status, escalated: true, staffAlerted: alert.sent?.length > 0 };
}

module.exports = {
  PRIORITIES,
  OFFICES,
  now,
  findTicket,
  findOwnedTicket,
  findOpenTicket,
  recentMessages,
  formatTicket,
  createTicketRecord,
  draftFollowupEmailRecord,
  escalateTicketRecord
};
