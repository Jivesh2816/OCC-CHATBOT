const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// Stage 5: real, file-backed persistence — replaces the in-memory
// chatHistory/tickets/criticLog arrays that reset on every restart or deploy.
// node:sqlite is Node's built-in driver (stable since 22.5, still flagged
// experimental), so this needs no native compilation and no separate DB
// server for local dev.
//
// Caveat: on Vercel's serverless runtime the project directory is read-only
// and /tmp doesn't survive cold starts, so this file still resets in that
// specific deployment target. Locally (and on any host with a real disk) it
// genuinely persists across restarts. Swapping in a hosted Postgres/LibSQL
// is the real fix for serverless — out of scope for this stage.
const DB_PATH = process.env.VERCEL ? '/tmp/data.sqlite' : path.join(__dirname, 'data.sqlite');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tickets (
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
  );

  CREATE TABLE IF NOT EXISTS critic_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    timestamp TEXT NOT NULL,
    message TEXT NOT NULL,
    intent TEXT,
    router_confidence REAL,
    match_type TEXT,
    flags_json TEXT NOT NULL,
    reasoning TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  CREATE INDEX IF NOT EXISTS idx_tickets_session ON tickets(session_id);
`);

module.exports = { db };
