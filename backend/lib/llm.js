// Groq client and the one model every stage uses.
const Groq = require('groq-sdk');
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
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
