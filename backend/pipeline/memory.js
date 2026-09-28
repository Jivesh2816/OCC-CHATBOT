// ---------------------------------------------------------------------------
// Multi-turn memory: the last few turns of this session go to the router, the
// answer generator, and the action agent, so a follow-up like "what should I
// do next?" is understood in the context of what came before.
// ---------------------------------------------------------------------------

const HISTORY_TURNS = 6;
const HISTORY_CHARS = 1200;

function historyAsChat(history) {
  return history.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: (m.role === 'staff' ? '[Reply from OCC staff] ' : '') + m.content.slice(0, HISTORY_CHARS)
  }));
}

function historyAsText(history, turns = 4) {
  return history.slice(-turns)
    .map(m => `${m.role === 'user' ? 'Student' : m.role === 'staff' ? 'Staff' : 'Assistant'}: ${m.content.slice(0, 400)}`)
    .join('\n');
}

// Follow-ups ("what if they still ignore me?") carry little to search on by
// themselves, so retrieval borrows the student's previous message.
function contextualQuery(message, history) {
  const previousUser = [...history].reverse().find(m => m.role === 'user');
  if (!previousUser || message.split(/\s+/).length >= 15) return message;
  return `${previousUser.content} ${message}`;
}

module.exports = { HISTORY_TURNS, historyAsChat, historyAsText, contextualQuery };
