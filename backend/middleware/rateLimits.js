const { rateLimit } = require('express-rate-limit');

// ---------------------------------------------------------------------------
// Rate limits, per client IP. Every chat message costs up to 3 Groq calls and
// a lease check can send ~4k tokens, so one person hammering the public
// endpoints could exhaust the free-tier quota and take the demo down for
// everyone. Limits are env-tunable (e.g. raised for an eval run). The store is
// in-memory, i.e. per serverless instance — a spike can land on several
// instances, so this caps abuse rather than enforcing an exact global quota.
// ---------------------------------------------------------------------------

const envInt = (name, fallback) => Number.parseInt(process.env[name], 10) || fallback;

function limiter(windowMs, limit, message) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => res.status(429).json({ error: message, rateLimited: true })
  });
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const chatLimits = [
  limiter(MINUTE, envInt('RATE_LIMIT_CHAT_PER_MIN', 12), "You're sending messages quickly — give it a minute and try again."),
  limiter(HOUR, envInt('RATE_LIMIT_CHAT_PER_HOUR', 100), "You've hit this hour's message limit. Try again a little later.")
];
const toolLimits = [
  limiter(MINUTE, envInt('RATE_LIMIT_TOOLS_PER_MIN', 5), 'Too many checks in a row — give it a minute and try again.'),
  limiter(HOUR, envInt('RATE_LIMIT_TOOLS_PER_HOUR', 30), "You've hit this hour's limit for lease and listing checks.")
];
// Slows brute-forcing the shared staff token.
const staffLimit = limiter(MINUTE, envInt('RATE_LIMIT_STAFF_PER_MIN', 60), 'Too many staff requests — slow down.');

module.exports = { chatLimits, toolLimits, staffLimit };
