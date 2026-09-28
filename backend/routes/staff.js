const express = require('express');
const { db } = require('../db');
const { now, findTicket, recentMessages, formatTicket } = require('../lib/tickets');
const { requireStaff } = require('../middleware/staffAuth');
const { staffLimit } = require('../middleware/rateLimits');

const router = express.Router();

// --- Staff (human-in-the-loop) ---------------------------------------------

const TICKET_STATUSES = ['open', 'escalated', 'in_progress', 'resolved'];

router.get('/staff/tickets', staffLimit, requireStaff, async (req, res) => {
  const rows = await db.all(`
    SELECT t.*, (SELECT COUNT(*) FROM ticket_replies r WHERE r.ticket_id = t.id) AS reply_count
    FROM tickets t
    ORDER BY CASE WHEN t.status = 'resolved' THEN 1 ELSE 0 END, t.escalated DESC, t.created_at DESC
  `);
  res.json({ tickets: rows.map(r => formatTicket(r)) });
});

router.get('/staff/tickets/:id', staffLimit, requireStaff, async (req, res) => {
  const row = await findTicket(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found' });
  const replies = await db.all('SELECT id, author, content, created_at FROM ticket_replies WHERE ticket_id = ? ORDER BY id', [row.id]);
  const conversation = await recentMessages(row.session_id, 50);
  const criticLog = (await db.all('SELECT * FROM critic_log WHERE session_id = ? ORDER BY id DESC LIMIT 20', [row.session_id]))
    .map(({ flags_json, ...entry }) => ({ ...entry, flags: JSON.parse(flags_json) }));
  res.json({ ticket: formatTicket(row, replies), conversation, criticLog });
});

router.post('/staff/tickets/:id/reply', staffLimit, requireStaff, async (req, res) => {
  const content = String(req.body?.content || '').trim();
  const author = String(req.body?.author || 'OCC staff').trim().slice(0, 60) || 'OCC staff';
  if (!content) return res.status(400).json({ error: 'Reply text is required' });

  const ticket = await findTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  await db.run('INSERT INTO ticket_replies (ticket_id, author, content, created_at) VALUES (?, ?, ?, ?)', [ticket.id, author, content, now()]);
  // Mirrored into the student's conversation so their open chat picks it up.
  await db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [ticket.session_id, 'staff', `**${author}** (re: ${ticket.id}): ${content}`, now()]);
  if (ticket.status !== 'resolved') await db.run('UPDATE tickets SET status = ? WHERE id = ?', ['in_progress', ticket.id]);
  res.json({ ok: true });
});

router.patch('/staff/tickets/:id', staffLimit, requireStaff, async (req, res) => {
  const { status } = req.body || {};
  if (!TICKET_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${TICKET_STATUSES.join(', ')}` });
  const result = await db.run('UPDATE tickets SET status = ? WHERE id = ?', [status, req.params.id]);
  if (!result.changes) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ok: true, status });
});

// Every critic decision, fired or not — the raw material for the eval set.
// Staff-only: rows contain students' raw messages.
router.get('/staff/critic-log', staffLimit, requireStaff, async (req, res) => {
  const rows = await db.all('SELECT * FROM critic_log ORDER BY id DESC LIMIT 500');
  res.json({ criticLog: rows.map(({ flags_json, ...row }) => ({ ...row, flags: JSON.parse(flags_json) })) });
});

// Old public paths, now behind the staff token.
router.get('/tickets', staffLimit, requireStaff, (_req, res) => res.redirect(307, '/staff/tickets'));
router.get('/critic-log', staffLimit, requireStaff, (_req, res) => res.redirect(307, '/staff/critic-log'));

module.exports = router;
