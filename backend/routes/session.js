const express = require('express');
const { db } = require('../db');
const { recentMessages, formatTicket } = require('../lib/tickets');
const { isSessionId } = require('../lib/validate');
const { sessionLimit } = require('../middleware/rateLimits');

const router = express.Router();

// A session's own conversation, oldest first. Session ids are random UUIDs
// held only by that browser tab, so this doubles as its access check.
router.get('/history', sessionLimit, async (req, res) => {
  const { sessionId } = req.query;
  if (!isSessionId(sessionId)) return res.status(400).json({ error: 'A valid sessionId query param is required' });
  res.json({ history: await recentMessages(sessionId, 100) });
});

router.delete('/history', sessionLimit, async (req, res) => {
  const { sessionId } = req.body || {};
  if (!isSessionId(sessionId)) return res.status(400).json({ error: 'A valid sessionId is required' });
  await db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
  res.json({ message: 'Chat history cleared for session', sessionId });
});

// The student's own tickets (not everyone's), with any staff replies.
router.get('/session/:sessionId/tickets', sessionLimit, async (req, res) => {
  if (!isSessionId(req.params.sessionId)) return res.status(400).json({ error: 'Invalid sessionId' });
  const rows = await db.all('SELECT * FROM tickets WHERE session_id = ? ORDER BY created_at DESC', [req.params.sessionId]);
  const tickets = [];
  for (const row of rows) {
    const replies = await db.all('SELECT id, author, content, created_at FROM ticket_replies WHERE ticket_id = ? ORDER BY id', [row.id]);
    tickets.push(formatTicket(row, replies));
  }
  res.json({ tickets });
});

// Staff replies newer than `after` (a message id), polled by the chat UI.
router.get('/session/:sessionId/updates', sessionLimit, async (req, res) => {
  if (!isSessionId(req.params.sessionId)) return res.status(400).json({ error: 'Invalid sessionId' });
  const after = Number(req.query.after) || 0;
  const updates = await db.all(
    "SELECT id, role, content, timestamp FROM messages WHERE session_id = ? AND role = 'staff' AND id > ? ORDER BY id",
    [req.params.sessionId, after]
  );
  res.json({ updates });
});

module.exports = router;
