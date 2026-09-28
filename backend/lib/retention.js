// Data retention. Messages and critic decisions can contain crisis text, so
// they're kept only as long as they're useful for follow-up and evaluation:
// RETENTION_DAYS (default 90), then deleted.
//
// Unresolved tickets are never purged — a person still has to act on them.
// Once a ticket is resolved and past the window, it and its replies go too.
//
// There's no always-on process on serverless to run a cron, so the purge runs
// opportunistically on incoming requests, at most once per PURGE_INTERVAL per
// instance. Every instance may run it; the deletes are idempotent.

const DEFAULT_DAYS = 90;
const PURGE_INTERVAL_MS = 6 * 60 * 60 * 1000;

function retentionDays(env = process.env) {
  const days = Number.parseInt(env.RETENTION_DAYS, 10);
  return days > 0 ? days : DEFAULT_DAYS;
}

// Timestamps are stored as ISO-8601 UTC strings, which sort lexically.
async function purgeExpired(db, { days = retentionDays(), now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  const expiredTickets = "SELECT id FROM tickets WHERE status = 'resolved' AND created_at < ?";

  const removed = {
    messages: (await db.run('DELETE FROM messages WHERE timestamp < ?', [cutoff])).changes,
    criticLog: (await db.run('DELETE FROM critic_log WHERE timestamp < ?', [cutoff])).changes,
    ticketReplies: (await db.run(`DELETE FROM ticket_replies WHERE ticket_id IN (${expiredTickets})`, [cutoff])).changes,
    tickets: (await db.run('DELETE FROM tickets WHERE status = \'resolved\' AND created_at < ?', [cutoff])).changes
  };
  // Sessions are only an id + timestamp; drop the ones nothing refers to anymore.
  removed.sessions = (await db.run(
    'DELETE FROM sessions WHERE created_at < ? AND id NOT IN (SELECT session_id FROM messages) AND id NOT IN (SELECT session_id FROM tickets)',
    [cutoff]
  )).changes;

  return { cutoff, removed };
}

let lastRun = 0;

// Express middleware form: never delays or fails a request because of a purge problem.
function retentionMiddleware(db) {
  return async (req, res, next) => {
    if (Date.now() - lastRun >= PURGE_INTERVAL_MS) {
      lastRun = Date.now();
      try {
        const { removed } = await purgeExpired(db);
        const total = Object.values(removed).reduce((a, b) => a + b, 0);
        if (total) console.log('Retention purge removed', removed);
      } catch (error) {
        console.error('Retention purge failed:', error.message);
      }
    }
    next();
  };
}

module.exports = { retentionDays, purgeExpired, retentionMiddleware };
