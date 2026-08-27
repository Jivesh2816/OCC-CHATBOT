const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const { db } = require('./db');

// Groq AI
const Groq = require('groq-sdk');
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// Nodemailer — jsonTransport never opens a network connection or sends real
// mail; it just returns the composed message as JSON. Safe default for a demo.
// Swap in real SMTP creds (nodemailer.createTransport({ host, auth, ... }))
// once you actually want ticket follow-ups to send.
const nodemailer = require('nodemailer');
const mailTransporter = nodemailer.createTransport({ jsonTransport: true });

const app = express();
const PORT = process.env.PORT || 5000;

// Diagnostics for env
console.log('Groq enabled:', !!process.env.GROQ_API_KEY);

// Load FAQ data
let faqData = {};
try {
  const faqPath = path.join(__dirname, 'faq.json');
  const faqRaw = fs.readFileSync(faqPath, 'utf8');
  faqData = JSON.parse(faqRaw);
  console.log('FAQ data loaded successfully');
} catch (error) {
  console.error('Error loading FAQ data:', error);
}

// Middleware
app.use(cors());
app.use(express.json());

// Stage 5: persistent storage (SQLite via db.js) — sessions, messages,
// tickets, and critic decisions all survive a restart now, scoped per session
// so two concurrent students never share history the way the old global
// in-memory array did.
const insertSession = db.prepare('INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)');
const insertMessage = db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)');
const selectRecentMessages = db.prepare('SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?');
const deleteSessionMessages = db.prepare('DELETE FROM messages WHERE session_id = ?');

const insertTicket = db.prepare(`
  INSERT INTO tickets (id, session_id, category, summary, priority, status, original_message, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectTicket = db.prepare('SELECT * FROM tickets WHERE id = ?');
const selectAllTickets = db.prepare('SELECT * FROM tickets ORDER BY created_at DESC');
const updateTicketEscalation = db.prepare('UPDATE tickets SET escalated = 1, status = ?, escalation_reason = ? WHERE id = ?');
const updateTicketEmails = db.prepare('UPDATE tickets SET emails_json = ? WHERE id = ?');

const insertCriticLog = db.prepare(`
  INSERT INTO critic_log (session_id, timestamp, message, intent, router_confidence, match_type, flags_json, reasoning)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const selectCriticLog = db.prepare('SELECT * FROM critic_log ORDER BY id DESC LIMIT ?');

function findTicket(ticketId) {
  return selectTicket.get(ticketId);
}

// Groq helper
async function generateWithGroq(message, faqContext = '') {
  try {
    const prompt = faqContext 
      ? `You are a helpful assistant for University of Waterloo off-campus students.

Here are relevant FAQs:
${faqContext}

Student question: ${message}

Provide a helpful, friendly answer based on the FAQs above. If the FAQs don't cover it, use your knowledge but stay focused on student life at UWaterloo. Be empathetic and action-oriented.`
      : `You are a helpful assistant for University of Waterloo off-campus students. 

Student question: ${message}

Provide a helpful, friendly, and practical answer about off-campus student life at UWaterloo. Be empathetic and action-oriented.`;

    const completion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant for University of Waterloo off-campus students."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      model: "openai/gpt-oss-20b",
      temperature: 0.7,
      max_tokens: 1024,
    });

    return completion.choices[0]?.message?.content?.trim() || "Sorry, I couldn't generate a response.";
  } catch (error) {
    console.error('Groq API Error:', error);
    return null;
  }
}

// Stage 1: Router agent — classifies intent before any retrieval happens.
// Maps each in-scope intent to the FAQ category retrieval should be scoped to.
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
Classify the student's message into exactly one intent:
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

Respond with ONLY strict JSON, no prose: {"intent": "<one of the above>", "confidence": <number 0 to 1>}`;

// Calls Groq to classify intent. Returns null on any failure so the caller
// can fall back to the pre-router behavior rather than breaking the chat.
async function classifyIntent(message) {
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
          { role: 'user', content: message }
        ],
        model: 'openai/gpt-oss-20b',
        temperature: attempt === 0 ? 0 : 0.4,
        // gpt-oss-20b spends some of its budget on hidden reasoning tokens
        // before emitting the JSON; 100 was too tight and truncated mid-object
        // often enough to show up as spurious null intents in the eval run.
        max_tokens: 300,
        response_format: { type: 'json_object' }
      });

      const raw = completion.choices[0]?.message?.content;
      const parsed = JSON.parse(raw);
      if (!VALID_INTENTS.includes(parsed.intent)) throw new Error(`invalid intent value: ${parsed.intent}`);

      const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
      return { intent: parsed.intent, confidence };
    } catch (error) {
      console.error(`Router classification failed (attempt ${attempt + 1}):`, error?.message || error);
    }
  }
  return null;
}

const URGENT_ESCALATION_MESSAGE = `⚠️ This sounds like it may need more urgent, real-world help than a chatbot can give.

Please reach out directly:
• **Emergency**: 911
• **Campus Police**: 519-888-4911
• **Waterloo Regional Police (non-emergency)**: 519-570-9777
• **Good2Talk (student mental health line)**: 1-866-925-5454

A human follow-up option for this kind of message is coming in a later stage of this project.`;

// Function to search FAQ for matching questions
function searchFAQ(userMessage) {
  const message = userMessage.toLowerCase().trim();
  
  // FAQ is now a simple array of objects with question/answer properties
  const allFAQs = Array.isArray(faqData) ? faqData : [];
  
  // First pass: Look for exact matches
  for (const faq of allFAQs) {
    const question = faq.question.toLowerCase();
    if (question === message) return faq;
  }

  // Second pass: Look for exact phrase matches (more restrictive)
  for (const faq of allFAQs) {
    const question = faq.question.toLowerCase();
    if (question.includes(message) || message.includes(question)) {
      // Additional check: ensure it's a meaningful match (not just single words)
      const messageWords = message.split(' ').filter(word => word.length > 2);
      const questionWords = question.split(' ').filter(word => word.length > 2);
      if (messageWords.length >= 2 && questionWords.length >= 2) {
        return faq;
      }
    }
  }

  // Third pass: Word-based matching with higher threshold
  for (const faq of allFAQs) {
    const question = faq.question.toLowerCase();
    const messageWords = message.split(' ').filter(word => word.length > 2);
    const questionWords = question.split(' ').filter(word => word.length > 2);

    if (messageWords.length >= 3 && questionWords.length >= 3) {
      const matchingWords = messageWords.filter(word =>
        questionWords.some(qWord => qWord.includes(word) || word.includes(qWord))
      );
      // Higher threshold for longer questions to avoid false matches
      const threshold = messageWords.length >= 5 ? 0.7 : 0.6;
      if (matchingWords.length > 0 && matchingWords.length / messageWords.length >= threshold) {
        return faq;
      }
    }
  }

  return null;
}

// The 6 topics surfaced in the sidebar/welcome UI. Academic and Clubs & Social
// FAQs still exist and are tagged, but aren't promoted as a nav entry point.
const NAV_TOPICS = ['Housing & Leases', 'Rent & Money', 'Getting Around', 'Health & Safety', 'Food & Essentials', 'Neighbours & Bylaws'];

function topicCounts() {
  const allFAQs = Array.isArray(faqData) ? faqData : [];
  return NAV_TOPICS.map(name => ({
    name,
    count: allFAQs.filter(f => f.category === name).length
  }));
}

// Lightweight fallback for common intents
function getIntelligentResponse(message) {
  const q = message.toLowerCase();
  if (q.includes('study') || q.includes('library')) return 'Try Davis Centre Library, Dana Porter Library, and SLC study areas.';
  if (q.includes('event')) return 'See WUSA Events and the UWaterloo events calendar for what\'s on this week.';
  if (q.includes('housing') || q.includes('rent')) return 'Check the Off-Campus Housing Office site for listings, leases, and tenant rights.';
  if (q.includes('food') || q.includes('meal') || q.includes('eat')) {
    return '🍕 Campus is full of food options! Check out:\n\n• **SLC**: Tim Hortons, Pizza Pizza, Subway, Booster Juice\n• **DC & MC**: Tim Hortons locations\n• **South Campus Hall**: Food court with diverse options\n• **Dining Halls**: Village 1, REV for all-you-can-eat\n• **WUSA Food Support**: Free hampers at SLC Turnkey\n\nUse your WatCard everywhere! Perfect for off-campus students.';
  }
  if (q.includes('tim') || q.includes('tim hortons') || q.includes('coffee')) {
    return '☕ Tim Hortons locations on campus:\n\n• **SLC** - Busiest, open late\n• **DC** (Davis Centre) - Between classes\n• **MC** (Math & Computer) - Quick runs\n• **South Campus Hall** - Near food court\n\nAll accept WatCard! Great for coffee, breakfast, and study snacks.';
  }
  if (q.includes('slc') && (q.includes('food') || q.includes('eat'))) {
    return '🎉 SLC Food Court has everything:\n\n• Tim Hortons - Coffee & breakfast\n• Pizza Pizza - Slices & whole pizzas\n• Subway - Subs & salads\n• Booster Juice - Smoothies\n• Teriyaki Experience - Asian bowls\n\nOpen late, WatCard accepted everywhere!';
  }
  if (q.includes('transport') || q.includes('bus') || q.includes('ion') || q.includes('grt')) return 'Your WatCard is your U-Pass for GRT/ION. Tap on entry. Might take 2–4 business days to activate if new.';
  return 'Happy to help! Ask me about housing, food, transportation, campus facilities, or wellness resources.';
}

// Function to find top N relevant FAQs for context.
// When category is given (from the router's intent), scoring is restricted
// to that category instead of running over all 42 entries.
function findRelevantFAQs(question, topN = 3, category = null) {
  const message = question.toLowerCase().trim();
  const allFAQs = (Array.isArray(faqData) ? faqData : [])
    .filter(faq => !category || faq.category === category);

  // Score all FAQs
  const scoredFAQs = allFAQs.map(faq => {
    const fq = faq.question.toLowerCase();
    let score = 0;
    
    // Exact match
    if (fq === message) score = 100;
    // Off-campus specific
    else if (message.includes('off-campus') && fq.includes('off-campus')) score = 95;
    else if (message.includes('food') && message.includes('off-campus') && fq.includes('food') && fq.includes('off-campus')) score = 95;
    // Residence specific
    else if (message.includes('residence') && fq.includes('residence')) score = 90;
    else if (message.includes('food') && message.includes('residence') && fq.includes('food') && fq.includes('residence')) score = 90;
    // Food specific
    else if (message.includes('food') && fq.includes('food')) score = 80;
    // Partial match
    else if (fq.includes(message) || message.includes(fq)) {
      const overlap = Math.min(message.length, fq.length) / Math.max(message.length, fq.length);
      score = overlap > 0.6 ? 70 : 40;
    } 
    // Word-based matching
    else {
      const m = message.split(' ').filter(w => w.length > 2);
      const qw = fq.split(' ').filter(w => w.length > 2);
      const matches = m.filter(w => qw.some(qw2 => qw2.includes(w) || w.includes(qw2)));
      if (matches.length > 0) {
        const ratio = matches.length / Math.max(m.length, qw.length);
        score = ratio >= 0.5 ? 60 : 30;
      }
    }
    
    return { faq, score };
  });
  
  // Sort by score descending and return top N
  scoredFAQs.sort((a, b) => b.score - a.score);
  return scoredFAQs.slice(0, topN).filter(item => item.score > 0).map(item => item.faq);
}

// Stage 2: Retrieval agent. Given the router's intent, pulls FAQ entries
// scoped to that intent's category (existing scoring, no vector DB) and
// generates a grounded answer. On Groq failure, falls back to direct FAQ
// match, then to the keyword responder. Always returns the same shape so
// the /chat route stays a thin dispatcher over router/retrieval/escalation.
async function retrievalAgent(message, intent) {
  const scopedCategory = intent ? INTENT_CATEGORY_MAP[intent] : null;
  const relevantFAQs = findRelevantFAQs(message, 3, scopedCategory);
  console.log('Retrieval agent found', relevantFAQs.length, 'FAQs', scopedCategory ? `(scoped to ${scopedCategory})` : '(unscoped)');

  const context = relevantFAQs.map(faq =>
    `Q: ${faq.question}\nA: ${faq.answer}`
  ).join('\n\n');

  try {
    const generated = await generateWithGroq(message, context);
    if (!generated || generated.includes("Sorry, I couldn't generate")) {
      throw new Error('Groq returned empty response');
    }
    console.log('Retrieval agent: Groq generated response with FAQ context');

    // Grounded in a real FAQ only if a relevant one was actually found
    const matchType = relevantFAQs.length > 0 ? 'faq' : 'fallback';
    const category = relevantFAQs.length > 0 ? relevantFAQs[0].category : null;

    return {
      response: generated,
      source: 'groq_with_faq_context',
      matchType,
      category,
      metadata: {
        intent,
        relevantFAQs: relevantFAQs.map(f => f.question),
        faqCount: relevantFAQs.length
      }
    };
  } catch (groqError) {
    console.error('Retrieval agent: Groq error:', groqError?.message || groqError);

    const faqMatch = searchFAQ(message);
    if (faqMatch) {
      console.log('Retrieval agent: used FAQ fallback');
      return {
        response: faqMatch.answer,
        source: 'faq_fallback',
        matchType: 'faq',
        category: faqMatch.category,
        metadata: { intent, error: 'groq_failed' }
      };
    }

    console.log('Retrieval agent: used intelligent response fallback');
    return {
      response: getIntelligentResponse(message),
      source: 'intelligent_response',
      matchType: 'fallback',
      category: null,
      metadata: { intent, error: 'groq_failed' }
    };
  }
}

// Stage 3: Action agent tools. Each one is a real side effect, not text —
// the model decides whether/which to call via function calling below.
function createTicketRecord({ category, summary, priority }, message, intent, sessionId) {
  const id = `T-${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();
  insertTicket.run(id, sessionId, category || intent || 'general', summary || message, priority || 'normal', 'open', message, createdAt);
  console.log('Action agent: created ticket', id, category, priority);
  return { ticketId: id, status: 'open' };
}

async function draftFollowupEmailRecord({ ticketId, to, subject, body }) {
  const ticket = findTicket(ticketId);
  if (!ticket) return { error: `No ticket found with id ${ticketId}` };

  // jsonTransport composes the message and returns it without sending anything.
  await mailTransporter.sendMail({
    from: 'occ-chatbot@uwaterloo-offcampus.example',
    to,
    subject,
    text: body
  });

  const emails = JSON.parse(ticket.emails_json || '[]');
  emails.push({ to, subject, body, sentAt: new Date().toISOString(), mock: true });
  updateTicketEmails.run(JSON.stringify(emails), ticketId);
  console.log('Action agent: drafted follow-up email for', ticketId, '->', to);
  return { ticketId, to, subject, mock: true };
}

function escalateTicketRecord({ ticketId, reason }) {
  const ticket = findTicket(ticketId);
  if (!ticket) return { error: `No ticket found with id ${ticketId}` };

  updateTicketEscalation.run('escalated', reason, ticketId);
  console.log('Action agent: escalated ticket', ticketId, '-', reason);
  return { ticketId, status: 'escalated', escalated: true };
}

// Explicit function-calling schemas — the model can only take these three
// actions, with these exact argument shapes. No free-text "do something" path.
const ACTION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'create_ticket',
      description: 'Create a follow-up ticket for a genuine unresolved issue that needs human attention, e.g. a landlord dispute or safety concern. Do not use for general informational questions.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Short category label, e.g. landlord_dispute, safety_concern, maintenance, harassment' },
          summary: { type: 'string', description: 'One or two sentence summary of the issue' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }
        },
        required: ['category', 'summary', 'priority']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'draft_followup_email',
      description: 'Draft a follow-up email about an existing ticket to a relevant campus support contact. Sent through a mock transport — use the ticketId returned by create_ticket.',
      parameters: {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          to: { type: 'string', description: 'Recipient email address, e.g. a campus office contact' },
          subject: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['ticketId', 'to', 'subject', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'escalate_ticket',
      description: 'Mark an existing ticket for human escalation because it needs a person, not the chatbot, to act on it.',
      parameters: {
        type: 'object',
        properties: {
          ticketId: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['ticketId', 'reason']
      }
    }
  }
];

const ACTION_SYSTEM_PROMPT = `You are an action-taking agent for a University of Waterloo off-campus student support system. You have three tools: create_ticket, draft_followup_email, escalate_ticket.

Only take action if the student's message describes a genuine, unresolved issue a human should follow up on — e.g. an ongoing landlord dispute, an unaddressed safety concern, harassment, or a crisis. Do NOT create a ticket for a general informational question (e.g. "what's a normal notice period", "where do I report a bylaw issue") — those are already answered by the FAQ system; only act on a specific incident.

If action is warranted: call create_ticket first. Use escalate_ticket if the issue needs a human to see it soon (urgent/high priority, safety-related). Only call draft_followup_email if a message to a campus office would concretely help this specific student, and only after create_ticket has returned a ticketId.

If no action is warranted, call no tools at all.`;

// Runs a bounded function-calling loop: the model decides which tools (if
// any) to call, we execute the real side effect, and feed the result back so
// it can decide the next step (e.g. escalate only after seeing the ticket id).
async function actionAgent(message, intent, category, sessionId) {
  const messages = [
    { role: 'system', content: ACTION_SYSTEM_PROMPT },
    { role: 'user', content: `Student message: "${message}"\nClassified intent: ${intent}\nFAQ category: ${category || 'none'}` }
  ];

  const actionsTaken = [];
  const MAX_STEPS = 4;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await groq.chat.completions.create({
        messages,
        model: 'openai/gpt-oss-20b',
        temperature: 0,
        tools: ACTION_TOOLS,
        tool_choice: 'auto',
        max_tokens: 512
      });

      const assistantMessage = completion.choices[0]?.message;
      if (!assistantMessage) break;
      messages.push(assistantMessage);

      const toolCalls = assistantMessage.tool_calls;
      if (!toolCalls || toolCalls.length === 0) {
        return { actionsTaken, summary: assistantMessage.content || null };
      }

      for (const toolCall of toolCalls) {
        let args = {};
        try {
          args = JSON.parse(toolCall.function.arguments || '{}');
        } catch (parseError) {
          console.error('Action agent: bad tool arguments JSON:', parseError.message);
        }

        let result;
        try {
          if (toolCall.function.name === 'create_ticket') {
            result = createTicketRecord(args, message, intent, sessionId);
          } else if (toolCall.function.name === 'draft_followup_email') {
            result = await draftFollowupEmailRecord(args);
          } else if (toolCall.function.name === 'escalate_ticket') {
            result = escalateTicketRecord(args);
          } else {
            result = { error: `Unknown tool: ${toolCall.function.name}` };
          }
        } catch (toolError) {
          result = { error: toolError.message };
        }

        actionsTaken.push({ tool: toolCall.function.name, args, result });
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: JSON.stringify(result) });
      }
    }

    return { actionsTaken, summary: 'Action agent reached its step limit.' };
  } catch (error) {
    console.error('Action agent failed:', error?.message || error);
    return { actionsTaken, summary: null, error: 'action_agent_failed' };
  }
}

// Only these intents can trigger the action agent — everything else is a
// plain FAQ lookup with nothing for a human to follow up on.
const ACTION_AGENT_INTENTS = ['urgent', 'housing', 'health_safety'];

// Stage 4: Critic agent. Deliberately rule-based, not another LLM call — a
// safety net that depends on a second probabilistic model is a weaker safety
// net. It runs at two points: before routing (can override the router's own
// classification) and after the response/actions are assembled (can force an
// escalation the action agent didn't make, flag low-confidence answers, and
// annotate policy-sensitive content). Every decision is logged (in SQLite,
// since Stage 5) for Stage 6's eval set, whether or not anything actually fired.

const SAFETY_SIGNAL_PHRASES = [
  'kill myself', 'want to die', 'end my life', 'suicidal', 'suicide',
  'hurt myself', 'self-harm', 'self harm',
  'being abused', 'domestic violence', 'assaulted', 'sexually assaulted',
  'hit me', 'hitting me', 'punched me', 'attacked me', 'threatened to kill',
  'someone is trying to hurt me', 'i am in danger', "i'm in danger",
  'not safe right now', 'unsafe right now', "don't feel safe", 'do not feel safe',
  'stalking me'
];

function findSafetySignal(text) {
  const lower = text.toLowerCase();
  return SAFETY_SIGNAL_PHRASES.find(phrase => lower.includes(phrase)) || null;
}

const LEGAL_ADVICE_PHRASES = [
  'you should sue', 'file a lawsuit', 'small claims court', 'this is illegal',
  'you have a legal right to', 'legally required to', 'in violation of the law',
  'landlord and tenant board', 'ltb hearing', 'take legal action', 'breach of contract'
];

function findPolicySensitivePhrase(text) {
  const lower = text.toLowerCase();
  return LEGAL_ADVICE_PHRASES.find(phrase => lower.includes(phrase)) || null;
}

// Runs after botResponse/matchType/category/actions are assembled but before
// anything is sent back to the user. Can mutate the response (add a
// disclaimer) and the actions list (force an escalation).
function criticReview({ message, intent, routerConfidence, matchType, botResponse, actionsTaken, preCheckOverride, sessionId }) {
  const flags = { safetyOverride: !!preCheckOverride, lowConfidence: false, policySensitive: false, escalationOverride: false };
  const reasons = [];
  if (preCheckOverride) reasons.push(preCheckOverride);

  let response = botResponse;
  let actions = [...actionsTaken];

  // (b) low-confidence or FAQ-less answers
  if (matchType === 'fallback' || (routerConfidence !== null && routerConfidence < 0.5)) {
    flags.lowConfidence = true;
    reasons.push(`no confident FAQ backing (matchType=${matchType}, routerConfidence=${routerConfidence})`);
  }

  // (c) policy-sensitive content (legal/landlord advice)
  const legalPhrase = findPolicySensitivePhrase(response);
  if (legalPhrase) {
    flags.policySensitive = true;
    reasons.push(`response contains legal-advice-like phrasing ("${legalPhrase}")`);
    response += `\n\n_Note: This is general information, not legal advice. For landlord-tenant disputes, contact Waterloo Region Community Legal Services or the Landlord and Tenant Board directly._`;
  }

  // (a) urgent/safety content that should reach a human regardless of what
  // the action agent decided — force-escalate any high/urgent ticket the
  // action agent created but didn't escalate.
  const createdTickets = actions.filter(a => a.tool === 'create_ticket' && a.result?.ticketId);
  const escalatedIds = new Set(actions.filter(a => a.tool === 'escalate_ticket').map(a => a.args.ticketId));
  for (const created of createdTickets) {
    const ticketId = created.result.ticketId;
    if (['high', 'urgent'].includes(created.args.priority) && !escalatedIds.has(ticketId)) {
      const reason = 'Critic override: high/urgent priority ticket was not escalated by the action agent.';
      const result = escalateTicketRecord({ ticketId, reason });
      actions.push({ tool: 'escalate_ticket', args: { ticketId, reason }, result, forcedByCritic: true });
      flags.escalationOverride = true;
      reasons.push(`ticket ${ticketId} was priority=${created.args.priority} but wasn't escalated — critic forced it`);
    }
  }

  const reasoning = reasons.length ? reasons.join('; ') : 'no critic flags raised';
  insertCriticLog.run(sessionId, new Date().toISOString(), message, intent, routerConfidence, matchType, JSON.stringify(flags), reasoning);

  return { response, actionsTaken: actions, flags };
}

app.get('/', (req, res) => {
  res.json({ message: 'Chatbot API is running!' });
});

app.get('/topics', (req, res) => {
  res.json({
    topics: topicCounts(),
    totalFAQs: Array.isArray(faqData) ? faqData.length : 0
  });
});

app.post('/chat', async (req, res) => {
  try {
    const { message, sessionId: incomingSessionId } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    // Stage 5: a session id ties messages/tickets/critic decisions together
    // in SQLite. The client sends back whatever id we gave it last time; if
    // it sends none (first message, or storage was cleared), a new one is
    // minted and returned for it to reuse.
    const sessionId = incomingSessionId || crypto.randomUUID();
    insertSession.run(sessionId, new Date().toISOString());
    insertMessage.run(sessionId, 'user', message, new Date().toISOString());

    console.log('Processing question:', message, 'session:', sessionId);

    // Stage 1: route before any retrieval. Null means the router itself
    // failed (Groq error/bad JSON) — treat that like the old ungated flow.
    const routerResult = await classifyIntent(message);
    let intent = routerResult?.intent || null;
    const routerConfidence = routerResult?.confidence ?? null;
    console.log('Router intent:', intent, 'confidence:', routerConfidence);

    // Stage 4: critic pre-check — a deterministic backstop independent of the
    // router's LLM judgment. If it fires, it wins regardless of what the
    // router decided.
    let preCheckOverride = null;
    const safetySignal = findSafetySignal(message);
    if (safetySignal && intent !== 'urgent') {
      preCheckOverride = `router classified as "${intent || 'unknown'}", but message matched safety-signal phrase "${safetySignal}" — critic overrode to urgent`;
      console.log('Critic pre-check override:', preCheckOverride);
      intent = 'urgent';
    }

    let botResponse, source, metadata, category, matchType;

    if (intent === 'urgent') {
      // Urgent-flag intents skip retrieval and generation entirely.
      botResponse = URGENT_ESCALATION_MESSAGE;
      source = 'router_escalation';
      matchType = 'escalation';
      category = null;
      metadata = { intent, confidence: routerConfidence };
      console.log('Router flagged urgent — skipping retrieval');
    } else if (intent === 'out_of_scope') {
      // Out-of-scope intents also skip FAQ retrieval; answer with general knowledge only.
      botResponse = await generateWithGroq(message);
      source = 'router_out_of_scope';
      matchType = 'fallback';
      category = null;
      metadata = { intent, confidence: routerConfidence };
      if (!botResponse) {
        botResponse = getIntelligentResponse(message);
        source = 'intelligent_response';
      }
      console.log('Router flagged out of scope — skipping FAQ retrieval');
    } else {
      // In-scope intent (or router failed and intent is null) — hand off to
      // the retrieval agent.
      const result = await retrievalAgent(message, intent);
      botResponse = result.response;
      source = result.source;
      matchType = result.matchType;
      category = result.category;
      metadata = { ...result.metadata, confidence: routerConfidence };
    }

    // Stage 3: action agent — only runs for intents where a real incident
    // (not just an FAQ lookup) might need a ticket, email, or escalation.
    let actions = [];
    if (ACTION_AGENT_INTENTS.includes(intent)) {
      const actionResult = await actionAgent(message, intent, category, sessionId);
      actions = actionResult.actionsTaken;
      console.log('Action agent result:', actions.length ? actions : 'no action taken');
    }

    // Stage 4: critic review — runs before anything is sent, can annotate the
    // response and force an escalation the action agent didn't make.
    const critic = criticReview({ message, intent, routerConfidence, matchType, botResponse, actionsTaken: actions, preCheckOverride, sessionId });
    botResponse = critic.response;
    actions = critic.actionsTaken;
    console.log('Critic flags:', critic.flags);

    insertMessage.run(sessionId, 'bot', botResponse, new Date().toISOString());
    const history = selectRecentMessages.all(sessionId, 10).reverse();
    console.log('Sending response:', {
      source,
      category,
      preview: botResponse.substring(0, 100) + '...',
      metadata
    });

    res.json({
      response: botResponse,
      sessionId,
      history,
      actions,
      criticFlags: critic.flags,
      source,
      category,
      matchType,
      intent,
      routerConfidence,
      metadata
    });
  } catch (error) {
    console.error('Error processing chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Scoped per session now — the old global array meant two concurrent
// students would silently share one history.
app.get('/history', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId query param is required' });
  const history = selectRecentMessages.all(sessionId, 100).reverse();
  res.json({ history });
});

app.delete('/history', (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  deleteSessionMessages.run(sessionId);
  res.json({ message: 'Chat history cleared for session', sessionId });
});

// Inspect tickets created by the action agent — now backed by SQLite, so
// these survive a server restart instead of resetting to [].
app.get('/tickets', (req, res) => {
  const rows = selectAllTickets.all().map(({ emails_json, ...ticket }) => ({
    ...ticket,
    escalated: !!ticket.escalated,
    emails: JSON.parse(emails_json || '[]')
  }));
  res.json({ tickets: rows });
});

// Every critic decision, fired or not — the raw material for Stage 6's eval set.
app.get('/critic-log', (req, res) => {
  const rows = selectCriticLog.all(500).map(({ flags_json, ...row }) => ({
    ...row,
    flags: JSON.parse(flags_json)
  }));
  res.json({ criticLog: rows });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
