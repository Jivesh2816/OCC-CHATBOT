// Ticket records and message history in SQLite (db.js). The action agent's
// tools, the critic, the lease escalation route, and staff routes share these.
const crypto = require('crypto');
const { db } = require('../db');
const { sendEscalationAlert } = require('./alerts');

// Nodemailer — jsonTransport never opens a network connection or sends real
// mail; it just returns the composed message as JSON. Safe default for a demo.
// Swap in real SMTP creds (nodemailer.createTransport({ host, auth, ... }))
// once you actually want ticket follow-ups to send.
const nodemailer = require('nodemailer');
const mailTransporter = nodemailer.createTransport({ jsonTransport: true });

const now = () => new Date().toISOString();

async function findTicket(ticketId) {
  return db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
}

async function recentMessages(sessionId, limit) {
  const rows = await db.all('SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?', [sessionId, limit]);
  return rows.reverse();
}

function formatTicket(row, replies = []) {
  const { emails_json, ...ticket } = row;
  return { ...ticket, escalated: !!ticket.escalated, emails: JSON.parse(emails_json || '[]'), replies };
}

async function createTicketRecord({ category, summary, priority }, message, intent, sessionId) {
  const id = `T-${crypto.randomUUID().slice(0, 8)}`;
  await db.run(
    `INSERT INTO tickets (id, session_id, category, summary, priority, status, original_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, sessionId, category || intent || 'general', summary || message, priority || 'normal', 'open', message, now()]
  );
  console.log('Action agent: created ticket', id, category, priority);
  return { ticketId: id, status: 'open' };
}

async function draftFollowupEmailRecord({ ticketId, to, subject, body }) {
  const ticket = await findTicket(ticketId);
  if (!ticket) return { error: `No ticket found with id ${ticketId}` };

  // jsonTransport composes the message and returns it without sending anything.
  await mailTransporter.sendMail({
    from: 'occ-chatbot@uwaterloo-offcampus.example',
    to,
    subject,
    text: body
  });

  const emails = JSON.parse(ticket.emails_json || '[]');
  emails.push({ to, subject, body, sentAt: now(), mock: true });
  await db.run('UPDATE tickets SET emails_json = ? WHERE id = ?', [JSON.stringify(emails), ticketId]);
  console.log('Action agent: drafted follow-up email for', ticketId, '->', to);
  return { ticketId, to, subject, mock: true };
}

async function escalateTicketRecord({ ticketId, reason }) {
  const ticket = await findTicket(ticketId);
  if (!ticket) return { error: `No ticket found with id ${ticketId}` };

  await db.run('UPDATE tickets SET escalated = 1, status = ?, escalation_reason = ? WHERE id = ?', ['escalated', reason, ticketId]);
  console.log('Action agent: escalated ticket', ticketId, '-', reason);

  // Only the first escalation alerts staff. Awaited (with a timeout inside)
  // rather than fire-and-forget: a serverless function can be frozen as soon
  // as the response is sent, which would silently drop the alert.
  const alert = ticket.escalated ? { skipped: 'already escalated' } : await sendEscalationAlert({ ...ticket, escalated: 1 }, reason);
  return { ticketId, status: 'escalated', escalated: true, staffAlerted: alert.sent?.length > 0 };
}

module.exports = { now, findTicket, recentMessages, formatTicket, createTicketRecord, draftFollowupEmailRecord, escalateTicketRecord };
