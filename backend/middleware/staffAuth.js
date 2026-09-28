const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Staff auth: a shared bearer token (STAFF_TOKEN). With no token configured,
// staff routes are disabled rather than open — the critic log and tickets hold
// raw student messages, including crisis text.
// ---------------------------------------------------------------------------

function requireStaff(req, res, next) {
  const expected = process.env.STAFF_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Staff dashboard is disabled: set STAFF_TOKEN on the server.' });
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const hash = s => crypto.createHash('sha256').update(s).digest();
  if (!provided || !crypto.timingSafeEqual(hash(provided), hash(expected))) {
    return res.status(401).json({ error: 'Invalid staff token' });
  }
  next();
}

module.exports = { requireStaff };
