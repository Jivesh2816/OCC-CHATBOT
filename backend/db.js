const path = require('path');

// Persistence behind one small async interface — run/get/all — with two
// interchangeable SQLite backends:
//
// - Local (default): node:sqlite, Node's built-in driver (stable since 22.5,
//   still flagged experimental). A file on disk; no native build, no server.
// - Hosted: set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) and the same SQL runs
//   against a Turso/libSQL database over HTTP. This is what makes tickets,
//   staff replies, and the critic log survive on Vercel, where each
//   serverless instance gets its own throwaway /tmp that resets on cold start.
//
// Both speak SQLite's dialect, so every query below is shared.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    category TEXT,
    summary TEXT,
    priority TEXT,
    status TEXT NOT NULL,
    escalated INTEGER NOT NULL DEFAULT 0,
    escalation_reason TEXT,
    original_message TEXT,
    emails_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS critic_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    timestamp TEXT NOT NULL,
    message TEXT NOT NULL,
    intent TEXT,
    router_confidence REAL,
    match_type TEXT,
    flags_json TEXT NOT NULL,
    reasoning TEXT
  )`,
  // Staff replies on a ticket. The same text is also written to `messages`
  // (role 'staff') so it shows up in the student's own conversation.
  `CREATE TABLE IF NOT EXISTS ticket_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_tickets_session ON tickets(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_replies_ticket ON ticket_replies(ticket_id)'
];

function createLocalDb() {
  const { DatabaseSync } = require('node:sqlite');
  // On Vercel without Turso configured, /tmp is the only writable path — it
  // works, but resets whenever the instance is recycled.
  // SQLITE_PATH overrides both (e.g. a throwaway file for demos or tests).
  const dbPath = process.env.SQLITE_PATH || (process.env.VERCEL ? '/tmp/data.sqlite' : path.join(__dirname, 'data.sqlite'));
  const sqlite = new DatabaseSync(dbPath);
  for (const statement of SCHEMA) sqlite.exec(statement);

  const cache = new Map();
  const prepare = sql => {
    if (!cache.has(sql)) cache.set(sql, sqlite.prepare(sql));
    return cache.get(sql);
  };

  return {
    kind: 'sqlite-file',
    ready: Promise.resolve(),
    async run(sql, params = []) {
      const info = prepare(sql).run(...params);
      return { lastInsertRowid: Number(info.lastInsertRowid), changes: Number(info.changes) };
    },
    async get(sql, params = []) {
      const row = prepare(sql).get(...params);
      return row ? { ...row } : undefined;
    },
    async all(sql, params = []) {
      return prepare(sql).all(...params).map(row => ({ ...row }));
    }
  };
}

function createTursoDb() {
  // The /web entry is fetch-only (no native binary), which keeps the Vercel
  // bundle small and portable.
  const { createClient } = require('@libsql/client/web');
  const client = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });

  const toObjects = result => result.rows.map(row => {
    const obj = {};
    result.columns.forEach((column, i) => { obj[column] = row[i]; });
    return obj;
  });

  const ready = client.batch(SCHEMA, 'write');

  return {
    kind: 'turso',
    ready,
    async run(sql, params = []) {
      await ready;
      const result = await client.execute({ sql, args: params });
      return { lastInsertRowid: Number(result.lastInsertRowid ?? 0), changes: result.rowsAffected };
    },
    async get(sql, params = []) {
      await ready;
      return toObjects(await client.execute({ sql, args: params }))[0];
    },
    async all(sql, params = []) {
      await ready;
      return toObjects(await client.execute({ sql, args: params }));
    }
  };
}

const db = process.env.TURSO_DATABASE_URL ? createTursoDb() : createLocalDb();

module.exports = { db };
