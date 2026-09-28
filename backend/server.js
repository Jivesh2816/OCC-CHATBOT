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

// Diagnostics for env
console.log('Groq enabled:', !!process.env.GROQ_API_KEY);
console.log('Database:', db.kind);
console.log('Staff dashboard:', process.env.STAFF_TOKEN ? 'enabled' : 'disabled (no STAFF_TOKEN)');
console.log('Staff alerts:', alertChannels().join(', ') || 'none configured');
console.log(`Official sources loaded: ${officialSources.length} passages`);
console.log(`Data retention: ${retentionDays()} days`);

// Middleware
app.use(cors());
// On Vercel the client IP arrives in X-Forwarded-For from Vercel's own proxy.
// Only trust that header there — locally anyone could spoof it to dodge limits.
if (process.env.VERCEL) app.set('trust proxy', 1);
// Lease PDFs arrive base64-encoded in JSON; Vercel caps request bodies at 4.5 MB.
app.use(express.json({ limit: '6mb' }));

app.use(retentionMiddleware(db));

app.use(require('./routes/chat'));
app.use(require('./routes/session'));
app.use(require('./routes/tools'));
app.use(require('./routes/staff'));

app.use((error, req, res, next) => {
  console.error('Unhandled route error:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

