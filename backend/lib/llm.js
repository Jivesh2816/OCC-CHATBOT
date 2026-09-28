// Groq client and the one model every stage uses.
const Groq = require('groq-sdk');
// A missing key must not crash the server at startup: every call then fails,
// and each stage falls back (rules, FAQ, crisis resources) as in an outage.
if (!process.env.GROQ_API_KEY) console.error('GROQ_API_KEY is not set — model calls will fail and the app will run on fallbacks.');
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || 'missing',
  // A stalled call shouldn't hold a student's request (or a serverless
  // function) open for minutes; one quick retry covers transient errors.
  timeout: 20 * 1000,
  maxRetries: 1
});
const MODEL = 'openai/gpt-oss-120b';

// JSON-mode completion used by the lease and listing checkers.
async function completeJSON(system, user) {
  const completion = await groq.chat.completions.create({
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0,
    // gpt-oss spends part of its budget on hidden reasoning before the JSON.
    max_tokens: 2500,
    response_format: { type: 'json_object' }
  });
  return completion.choices[0]?.message?.content || '';
}

module.exports = { groq, MODEL, completeJSON };
