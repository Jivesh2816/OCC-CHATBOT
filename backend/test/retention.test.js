const test = require('node:test');
const assert = require('node:assert/strict');

// A throwaway in-memory database for this test process only.
process.env.SQLITE_PATH = ':memory:';
delete process.env.TURSO_DATABASE_URL;
const { db } = require('../db');
const { purgeExpired, retentionDays } = require('../lib/retention');

const NOW = new Date('2026-09-28T12:00:00Z');
const daysAgo = n => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

async function seed() {
  await db.run('INSERT INTO sessions (id, created_at) VALUES (?, ?)', ['old', daysAgo(200)]);
  await db.run('INSERT INTO sessions (id, created_at) VALUES (?, ?)', ['recent', daysAgo(5)]);
  await db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', ['old', 'user', 'old message', daysAgo(200)]);
  await db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', ['recent', 'user', 'new message', daysAgo(5)]);
  await db.run('INSERT INTO critic_log (session_id, timestamp, message, flags_json) VALUES (?, ?, ?, ?)', ['old', daysAgo(200), 'm', '{}']);
  await db.run('INSERT INTO critic_log (session_id, timestamp, message, flags_json) VALUES (?, ?, ?, ?)', ['recent', daysAgo(5), 'm', '{}']);
  const ticket = (id, status, age) => db.run(
    'INSERT INTO tickets (id, session_id, status, created_at) VALUES (?, ?, ?, ?)', [id, 'old', status, daysAgo(age)]
  );
  await ticket('T-old-resolved', 'resolved', 200);
  await ticket('T-old-open', 'escalated', 200);
  await ticket('T-new-resolved', 'resolved', 5);
  await db.run('INSERT INTO ticket_replies (ticket_id, author, content, created_at) VALUES (?, ?, ?, ?)', ['T-old-resolved', 'staff', 'r', daysAgo(199)]);
}

test('defaults to 90 days and reads RETENTION_DAYS', () => {
  assert.equal(retentionDays({}), 90);
  assert.equal(retentionDays({ RETENTION_DAYS: '30' }), 30);
  assert.equal(retentionDays({ RETENTION_DAYS: 'nonsense' }), 90);
});

test('purges expired data but never an unresolved ticket', async () => {
  await seed();
  const { removed } = await purgeExpired(db, { days: 90, now: NOW });
  assert.deepEqual(removed, { messages: 1, criticLog: 1, ticketReplies: 1, tickets: 1, sessions: 0 });

  const ids = (await db.all('SELECT id FROM tickets ORDER BY id')).map(r => r.id);
  assert.deepEqual(ids, ['T-new-resolved', 'T-old-open']);
  assert.deepEqual((await db.all('SELECT content FROM messages')).map(r => r.content), ['new message']);
  // 'old' session survives: its unresolved ticket still refers to it.
  assert.equal((await db.all('SELECT id FROM sessions')).length, 2);
});

test('running the purge again removes nothing more', async () => {
  const { removed } = await purgeExpired(db, { days: 90, now: NOW });
  assert.deepEqual(removed, { messages: 0, criticLog: 0, ticketReplies: 0, tickets: 0, sessions: 0 });
});
