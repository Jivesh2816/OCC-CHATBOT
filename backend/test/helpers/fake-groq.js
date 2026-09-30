// A scripted stand-in for the Groq API, installed on the app's shared client
// so pipeline and API tests run with no network and no key. Each test passes
// a handler that sees the request and returns a canned model response.
//
// Load this before anything else in a test file: it also points the database
// at an in-memory SQLite and clears alert channels, so nothing leaves the process.
process.env.SQLITE_PATH = ':memory:';
for (const key of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'STAFF_ALERT_WEBHOOK_URL', 'SMTP_URL', 'STAFF_ALERT_EMAIL']) delete process.env[key];
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-key-not-used';

const { groq } = require('../../lib/llm');

// Which pipeline stage made a request, from its shape.
function stageOf(params) {
  if (params.tools) return 'action';
  if (params.response_format?.type === 'json_object') return /intent router/i.test(params.messages[0].content) ? 'router' : 'json';
  return 'answer';
}

const message = (content, toolCalls) => ({ choices: [{ message: { role: 'assistant', content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const routerReply = (intent, { confidence = 0.95, incident = false } = {}) => message(JSON.stringify({ intent, confidence, incident }));
const toolCall = (name, args, id = `call_${name}_${Math.random().toString(36).slice(2, 7)}`) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });

async function* streamOf(text) {
  for (const piece of text.match(/.{1,12}/gs) || []) yield { choices: [{ delta: { content: piece } }] };
}

// handler(stage, params, callIndexForStage) → response object, a string (answer
// text), or throws to simulate an API failure.
function install(handler) {
  const calls = [];
  const counts = {};
  groq.chat.completions.create = async params => {
    const stage = stageOf(params);
    counts[stage] = (counts[stage] || 0) + 1;
    calls.push({ stage, params });
    const result = await handler(stage, params, counts[stage] - 1);
    if (params.stream) return streamOf(typeof result === 'string' ? result : result.choices[0].message.content || '');
    return typeof result === 'string' ? message(result) : result;
  };
  return calls;
}

function apiError(status, text = 'simulated failure') {
  const error = new Error(`${status} ${text}`);
  error.status = status;
  return error;
}

module.exports = { install, routerReply, message, toolCall, apiError, stageOf };
