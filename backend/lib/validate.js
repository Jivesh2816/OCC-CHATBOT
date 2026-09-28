// Request validation shared by the routes.

// Longer than any real question; stops a single request from filling the
// database or burning the model's token budget.
const MAX_MESSAGE_CHARS = 2000;

// Session ids are minted server-side as random UUIDs and double as the access
// check for a conversation, so anything else ("1", "test") is rejected:
// a guessable id would let one person read another's chat.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isSessionId = value => typeof value === 'string' && UUID.test(value);

// Returns { message } or { error } for a chat request body.
function parseChatMessage(body) {
  const message = body?.message;
  if (typeof message !== 'string' || !message.trim()) return { error: 'Message is required' };
  if (message.length > MAX_MESSAGE_CHARS) return { error: `Please keep messages under ${MAX_MESSAGE_CHARS} characters.` };
  return { message: message.trim() };
}

module.exports = { MAX_MESSAGE_CHARS, isSessionId, parseChatMessage };
