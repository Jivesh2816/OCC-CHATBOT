const { groq, MODEL } = require('../lib/llm');
const { historyAsText } = require('./memory');

// ---------------------------------------------------------------------------
// Stage 1: Router agent — classifies intent before any retrieval happens.
// Maps each in-scope intent to the FAQ category retrieval should be scoped to.
// ---------------------------------------------------------------------------

const INTENT_CATEGORY_MAP = {
  housing: 'Housing & Leases',
  health_safety: 'Health & Safety',
  rent_money: 'Rent & Money',
  food: 'Food & Essentials',
  transit: 'Getting Around',
  bylaws: 'Neighbours & Bylaws',
  academic: 'Academic',
  social: 'Clubs & Social',
};
const VALID_INTENTS = [...Object.keys(INTENT_CATEGORY_MAP), 'urgent', 'out_of_scope'];

const ROUTER_SYSTEM_PROMPT = `You are an intent router for a University of Waterloo off-campus student support chatbot.
Classify the student's NEW message into exactly one intent. Earlier conversation, if given, is only context for interpreting short follow-ups.
- housing: leases, landlords, maintenance, roommates, moving
- health_safety: physical/mental health, safety concerns, harassment (non-urgent)
- rent_money: rent, budgeting, deposits, bills, financial aid
- food: groceries, meal options, food banks
- transit: buses, ION, U-Pass, getting around Waterloo/Kitchener
- bylaws: noise, parking, city bylaws, neighbour disputes
- academic: courses, co-op, academic advising
- social: clubs, events, making friends
- urgent: immediate safety risk, self-harm, violence, abuse, or crisis language — always choose this over any other category if present
- out_of_scope: anything unrelated to UWaterloo off-campus student life

Also decide "incident": true if the student describes a specific, ongoing problem happening to them that a person may need to follow up on (e.g. "my landlord hasn't fixed the heat in 3 weeks", "my roommate is harassing me"); false for general or hypothetical questions (e.g. "how much notice do I need to give?", "can a landlord raise rent?").

Respond with ONLY strict JSON, no prose: {"intent": "<one of the above>", "confidence": <number 0 to 1>, "incident": <true or false>}`;

// Calls Groq to classify intent. Returns null on any failure so the caller
// can fall back to the pre-router behavior rather than breaking the chat.
async function classifyIntent(message, history = []) {
  const context = historyAsText(history, 2);
  const userContent = context
    ? `Earlier conversation (context only):\n${context}\n\nNew message to classify: ${message}`
    : message;

  // Two attempts. The eval run showed json_validate_failed sometimes comes
  // back as an empty completion, and at temperature 0 it's deterministic —
  // retrying with the exact same input reliably reproduces the same empty
  // result. So the retry nudges temperature up slightly to actually take a
  // different generation path instead of repeating a guaranteed failure.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completion = await groq.chat.completions.create({
        messages: [
          { role: 'system', content: ROUTER_SYSTEM_PROMPT },
          { role: 'user', content: userContent }
        ],
        model: MODEL,
        temperature: attempt === 0 ? 0 : 0.4,
        // gpt-oss spends some of its budget on hidden reasoning tokens
        // before emitting the JSON; 100 was too tight and truncated mid-object
        // often enough to show up as spurious null intents in the eval run.
        max_tokens: 300,
        response_format: { type: 'json_object' }
      });

      const raw = completion.choices[0]?.message?.content;
      const parsed = JSON.parse(raw);
      if (!VALID_INTENTS.includes(parsed.intent)) throw new Error(`invalid intent value: ${parsed.intent}`);

      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
      // Missing or malformed → assume an incident, so the action agent still
      // runs. Wrongly skipping it could drop a real problem; wrongly running
      // it only costs one extra call.
      const incident = parsed.incident !== false;
      return { intent: parsed.intent, confidence, incident };
    } catch (error) {
      console.error(`Router classification failed (attempt ${attempt + 1}):`, error?.message || error);
    }
  }
  return null;
}

module.exports = { INTENT_CATEGORY_MAP, VALID_INTENTS, classifyIntent };
