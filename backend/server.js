const express = require('express');
// Routes rejected promises from async handlers to the error middleware at the
// bottom instead of leaving an unhandled rejection and a hung request.
require('express-async-errors');
const cors = require('cors');
require('dotenv').config();

const { db } = require('./db');
const { alertChannels } = require('./lib/alerts');
const { officialSources } = require('./lib/knowledge');
const { retentionDays, retentionMiddleware } = require('./lib/retention');

// pipeline/ holds the agent stages (router → retrieval → action → critic),
// lib/ the shared building blocks, routes/ the HTTP surface.
const app = express();
const PORT = process.env.PORT || 5000;
app.disable('x-powered-by');

// Only the student frontend may call the API from a browser. Server-to-server
// callers (the eval, curl) send no Origin header and aren't affected.
// CORS_ORIGINS overrides the list, comma-separated (e.g. to add a preview URL).
const allowedOrigins = (process.env.CORS_ORIGINS || 'https://occ-chatbot-36q6.vercel.app,http://localhost:3000,http://localhost:5173')
  .split(',').map(o => o.trim()).filter(Boolean);

// Diagnostics for env
console.log('Groq enabled:', !!process.env.GROQ_API_KEY);
console.log('Database:', db.kind);
console.log('Staff dashboard:', process.env.STAFF_TOKEN ? 'enabled' : 'disabled (no STAFF_TOKEN)');
console.log('Staff alerts:', alertChannels().join(', ') || 'none configured');
console.log(`Official sources loaded: ${officialSources.length} passages`);
console.log(`Data retention: ${retentionDays()} days`);
console.log('CORS origins:', allowedOrigins.join(', '));

// Middleware
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)) }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  next();
});
// On Vercel the client IP arrives in X-Forwarded-For from Vercel's own proxy.
// Only trust that header there — locally anyone could spoof it to dodge limits.
if (process.env.VERCEL) app.set('trust proxy', 1);
// Lease PDFs arrive base64-encoded in JSON (Vercel caps bodies at 4.5 MB);
// every other route gets a small limit so one request can't be megabytes.
const leaseJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '100kb' });
app.use((req, res, next) => (req.path === '/lease/check' ? leaseJson : smallJson)(req, res, next));

app.use(retentionMiddleware(db));

app.use(require('./routes/chat'));
app.use(require('./routes/session'));
app.use(require('./routes/tools'));
app.use(require('./routes/staff'));

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  // Client mistakes from body parsing are the client's, not a server error.
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Request body must be valid JSON.' });
  if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  console.error('Unhandled route error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

