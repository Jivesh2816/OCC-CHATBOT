const express = require('express');
// Routes rejected promises from async handlers to the error middleware at the
// bottom instead of leaving an unhandled rejection and a hung request.
require('express-async-errors');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const { db } = require('./db');
const { createIndex } = require('./lib/bm25');
const critic = require('./lib/critic');
const { analyzeLease } = require('./lib/lease');
const { analyzeListing } = require('./lib/scam');

// Groq AI
const Groq = require('groq-sdk');
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});
const MODEL = 'openai/gpt-oss-20b';

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
console.log('Database:', db.kind);
console.log('Staff dashboard:', process.env.STAFF_TOKEN ? 'enabled' : 'disabled (no STAFF_TOKEN)');

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

// Official passages (UW Off-Campus Housing, Government of Ontario, UW Special
// Constable Service), scraped by scripts/build-sources.js and committed, so
// answers can cite a real page instead of the model's memory.
const officialSources = require('./sources/official.json');
const sourcesById = Object.fromEntries(officialSources.map(s => [s.id, s]));
const sourceIndex = createIndex(officialSources, s => `${s.heading} ${s.text}`);
const SOURCE_MIN_SCORE = 6;
// The passages cover tenancy, leases, rent, and rental fraud — only look them
// up for intents where that's relevant (null = router failed, so don't gate).
const SOURCE_INTENTS = new Set(['housing', 'rent_money', null]);

// Students and official pages describe the same thing in different words.
// BM25 is purely lexical, so bridge the most common gaps explicitly.
const QUERY_SYNONYMS = {
  fix: 'repair maintenance', fixed: 'repair maintenance', broken: 'repair maintenance', heat: 'repair maintenance',
  heater: 'repair maintenance', mold: 'repair maintenance', leak: 'repair maintenance',
  sublet: 'assign assignment', sublease: 'sublet assign', subletting: 'sublet assign',
  raise: 'increase guideline', hike: 'increase guideline',
  kick: 'evict eviction terminate', kicked: 'evict eviction terminate', evicted: 'eviction', evicting: 'eviction',
  scam: 'fraud scam', scammed: 'fraud scam', fake: 'fraud scam',
  enter: 'entry notice', entering: 'entry notice', barge: 'entry notice'
};
function expandQuery(query) {
  const extra = query.toLowerCase().split(/[^a-z']+/).map(w => QUERY_SYNONYMS[w]).filter(Boolean);
  return extra.length ? `${query} ${extra.join(' ')}` : query;
}
console.log(`Official sources loaded: ${officialSources.length} passages`);

// Middleware
app.use(cors());
// Lease PDFs arrive base64-encoded in JSON; Vercel caps request bodies at 4.5 MB.
app.use(express.json({ limit: '6mb' }));

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Persistence helpers (SQLite via db.js)
// ---------------------------------------------------------------------------

async function findTicket(ticketId) {
  return db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
}

async function recentMessages(sessionId, limit) {
  const rows = await db.all('SELECT id, role, content, timestamp FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?', [sessionId, limit]);
  return rows.reverse();
}

function formatTicket(row, replies = []) {
  const { emails_json, ...ticket } = row;
  return { ...ticket, escalated: !!ticket.escalated, emails: JSON.parse(emails_json || '[]'), replies };
}

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

// ---------------------------------------------------------------------------
// Groq helpers
// ---------------------------------------------------------------------------

const ANSWER_SYSTEM_PROMPT = `You are a helpful assistant for University of Waterloo off-campus students. Be friendly, empathetic, practical, and concise.

You may be given two kinds of context:
- FAQ entries curated by the Off-Campus Community team.
- Numbered official passages, e.g. [1], from UW Off-Campus Housing, the Government of Ontario, or UW Special Constable Service.

Ground your answer in that context. When a sentence relies on an official passage, cite it inline with its number, like [1]. Only cite numbers you were given, and never invent a source. Never state specific form numbers, fees, phone numbers, deadlines, or percentages unless they appear in the context. If the context doesn't cover the question, say so briefly and give careful general guidance focused on student life in Waterloo.`;

async function generateAnswer({ message, faqs = [], sources = [], history = [], onToken = null }) {
  const contextParts = [];
  if (faqs.length) {
    contextParts.push('FAQ entries:\n' + faqs.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n\n'));
  }
  if (sources.length) {
    contextParts.push('Official passages:\n' + sources.map((s, i) => `[${i + 1}] ${s.publisher} — ${s.heading}\n${s.text}`).join('\n\n'));
  }
  const userContent = contextParts.length
    ? `${contextParts.join('\n\n')}\n\nStudent question: ${message}`
    : `Student question: ${message}`;

  const request = {
    model: MODEL,
    messages: [
      { role: 'system', content: ANSWER_SYSTEM_PROMPT },
      ...historyAsChat(history),
      { role: 'user', content: userContent }
    ],
    temperature: 0.7,
    max_tokens: 1400
  };

  try {
    if (!onToken) {
      const completion = await groq.chat.completions.create(request);
      return completion.choices[0]?.message?.content?.trim() || null;
    }

    // Streamed: tokens are forwarded to the client as they arrive.
    const stream = await groq.chat.completions.create({ ...request, stream: true });
    let text = '';
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        text += delta;
        onToken(delta);
      }
    }
    return text.trim() || null;
  } catch (error) {
    console.error('Groq API Error:', error?.message || error);
    return null;
  }
}

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

Respond with ONLY strict JSON, no prose: {"intent": "<one of the above>", "confidence": <number 0 to 1>}`;

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

This conversation has also been flagged for follow-up by a person, and any reply will show up right here — but please don't wait on that if you're in danger. Use the numbers above.`;

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

// Official passages relevant to the question, ranked by BM25.
function findOfficialSources(query, intent, topN = 3) {
  if (!SOURCE_INTENTS.has(intent)) return [];
  return sourceIndex.search(expandQuery(query), { topN, minScore: SOURCE_MIN_SCORE }).map(r => r.doc);
}

// gpt-oss often writes citations as 【1】 or 【1†source】 — normalize to [1].
function normalizeCitations(text) {
  return text ? text.replace(/【\s*(\d+)[^】]*】/g, '[$1]') : text;
}

// Which of the numbered passages the answer actually cited, e.g. "[2]".
function toCitations(sources, answer) {
  return sources.map((s, i) => ({
    n: i + 1,
    id: s.id,
    title: s.heading,
    publisher: s.publisher,
    url: s.url,
    cited: new RegExp(`\\[${i + 1}\\]`).test(answer || '')
  }));
}

// ---------------------------------------------------------------------------
// Stage 2: Retrieval agent. Given the router's intent, pulls FAQ entries
// scoped to that intent's category plus official passages (BM25, no vector
// DB), and generates a grounded answer. On Groq failure, falls back to direct
// FAQ match, then to the keyword responder.
// ---------------------------------------------------------------------------

async function retrievalAgent(message, intent, { history = [], onToken = null, onRetrieved = null } = {}) {
  const scopedCategory = intent ? INTENT_CATEGORY_MAP[intent] : null;
  const query = contextualQuery(message, history);

  let relevantFAQs = findRelevantFAQs(message, 3, scopedCategory);
  if (relevantFAQs.length === 0 && query !== message) relevantFAQs = findRelevantFAQs(query, 3, scopedCategory);
  const sources = findOfficialSources(query, intent);
  console.log('Retrieval agent found', relevantFAQs.length, 'FAQs and', sources.length, 'official passages', scopedCategory ? `(scoped to ${scopedCategory})` : '(unscoped)');
  onRetrieved?.({ faqs: relevantFAQs.map(f => f.question), sources: sources.map(s => ({ id: s.id, title: s.heading, publisher: s.publisher })) });

  const generated = normalizeCitations(await generateAnswer({ message, faqs: relevantFAQs, sources, history, onToken }));
  if (generated) {
    console.log('Retrieval agent: Groq generated response with FAQ/official context');
    // Grounded in a real FAQ or official passage only if one was actually found
    const matchType = relevantFAQs.length > 0 ? 'faq' : sources.length > 0 ? 'official' : 'fallback';
    const category = relevantFAQs.length > 0 ? relevantFAQs[0].category : sources.length > 0 ? sources[0].publisher : null;

    return {
      response: generated,
      source: 'groq_with_context',
      matchType,
      category,
      citations: toCitations(sources, generated),
      metadata: {
        intent,
        relevantFAQs: relevantFAQs.map(f => f.question),
        faqCount: relevantFAQs.length,
        sourceCount: sources.length
      }
    };
  }

  console.error('Retrieval agent: Groq returned nothing, using fallbacks');
  const faqMatch = searchFAQ(message);
  if (faqMatch) {
    console.log('Retrieval agent: used FAQ fallback');
    return {
      response: faqMatch.answer,
      source: 'faq_fallback',
      matchType: 'faq',
      category: faqMatch.category,
      citations: [],
      metadata: { intent, error: 'groq_failed' }
    };
  }

  console.log('Retrieval agent: used intelligent response fallback');
  return {
    response: getIntelligentResponse(message),
    source: 'intelligent_response',
    matchType: 'fallback',
    category: null,
    citations: [],
    metadata: { intent, error: 'groq_failed' }
  };
}

// ---------------------------------------------------------------------------
// Stage 3: Action agent tools. Each one is a real side effect, not text —
// the model decides whether/which to call via function calling below.
// ---------------------------------------------------------------------------

async function createTicketRecord({ category, summary, priority }, message, intent, sessionId) {
  const id = `T-${crypto.randomUUID().slice(0, 8)}`;
  await db.run(
    `INSERT INTO tickets (id, session_id, category, summary, priority, status, original_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, sessionId, category || intent || 'general', summary || message, priority || 'normal', 'open', message, now()]
  );
  console.log('Action agent: created ticket', id, category, priority);
  return { ticketId: id, status: 'open' };
}

async function draftFollowupEmailRecord({ ticketId, to, subject, body }) {
  const ticket = await findTicket(ticketId);
  if (!ticket) return { error: `No ticket found with id ${ticketId}` };

  // jsonTransport composes the message and returns it without sending anything.
  await mailTransporter.sendMail({
    from: 'occ-chatbot@uwaterloo-offcampus.example',
    to,
    subject,
    text: body
  });

  const emails = JSON.parse(ticket.emails_json || '[]');
  emails.push({ to, subject, body, sentAt: now(), mock: true });
  await db.run('UPDATE tickets SET emails_json = ? WHERE id = ?', [JSON.stringify(emails), ticketId]);
  console.log('Action agent: drafted follow-up email for', ticketId, '->', to);
  return { ticketId, to, subject, mock: true };
}

async function escalateTicketRecord({ ticketId, reason }) {
  const ticket = await findTicket(ticketId);
  if (!ticket) return { error: `No ticket found with id ${ticketId}` };

  await db.run('UPDATE tickets SET escalated = 1, status = ?, escalation_reason = ? WHERE id = ?', ['escalated', reason, ticketId]);
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
async function actionAgent(message, intent, category, sessionId, history = []) {
  const context = historyAsText(history, 4);
  const messages = [
    { role: 'system', content: ACTION_SYSTEM_PROMPT },
    { role: 'user', content: `${context ? `Earlier conversation (context only):\n${context}\n\n` : ''}Student message: "${message}"\nClassified intent: ${intent}\nFAQ category: ${category || 'none'}` }
  ];

  const actionsTaken = [];
  const MAX_STEPS = 4;

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await groq.chat.completions.create({
        messages,
        model: MODEL,
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
            result = await createTicketRecord(args, message, intent, sessionId);
          } else if (toolCall.function.name === 'draft_followup_email') {
            result = await draftFollowupEmailRecord(args);
          } else if (toolCall.function.name === 'escalate_ticket') {
            result = await escalateTicketRecord(args);
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

// ---------------------------------------------------------------------------
// Stage 4: Critic side effects. The rules live in lib/critic.js (pure); this
// carries out what they decide and logs every decision, fired or not.
// ---------------------------------------------------------------------------

async function applyCritic({ message, intent, routerConfidence, matchType, botResponse, actionsTaken, preCheckOverride, sessionId }) {
  const decision = critic.postCheck({ intent, routerConfidence, matchType, botResponse, actionsTaken, preCheckOverride });
  const actions = [...actionsTaken];

  for (const ticketId of decision.escalate) {
    const reason = 'Critic override: high/urgent priority ticket was not escalated by the action agent.';
    const result = await escalateTicketRecord({ ticketId, reason });
    actions.push({ tool: 'escalate_ticket', args: { ticketId, reason }, result, forcedByCritic: true });
  }

  if (decision.createUrgent) {
    const args = { category: 'crisis', summary: 'Urgent/safety message — opened by the critic because no ticket existed.', priority: 'urgent' };
    const created = await createTicketRecord(args, message, intent, sessionId);
    actions.push({ tool: 'create_ticket', args, result: created, forcedByCritic: true });
    const reason = 'Critic override: urgent message must reach a human.';
    const escalated = await escalateTicketRecord({ ticketId: created.ticketId, reason });
    actions.push({ tool: 'escalate_ticket', args: { ticketId: created.ticketId, reason }, result: escalated, forcedByCritic: true });
  }

  await db.run(
    `INSERT INTO critic_log (session_id, timestamp, message, intent, router_confidence, match_type, flags_json, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, now(), message, intent, routerConfidence, matchType, JSON.stringify(decision.flags), decision.reasoning]
  );

  return { response: decision.response, actionsTaken: actions, flags: decision.flags, reasoning: decision.reasoning };
}

// ---------------------------------------------------------------------------
// The pipeline. `emit` receives trace events as each stage runs; /chat/stream
// forwards them to the browser, /chat ignores them and returns the final
// payload. Same code path either way, so the eval exercises what users get.
// ---------------------------------------------------------------------------

async function runPipeline({ message, sessionId: incomingSessionId, emit = () => {} }) {
  // A session id ties messages/tickets/critic decisions together. The client
  // sends back whatever id we gave it last time; if it sends none (first
  // message, or storage was cleared), a new one is minted and returned.
  const sessionId = incomingSessionId || crypto.randomUUID();
  const history = await recentMessages(sessionId, HISTORY_TURNS);
  await db.run('INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)', [sessionId, now()]);
  await db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [sessionId, 'user', message, now()]);
  emit({ type: 'session', sessionId, memoryTurns: history.length });

  const trace = [];
  const stage = async (name, fn, describe) => {
    emit({ type: 'step', stage: name, status: 'running' });
    const started = Date.now();
    const result = await fn();
    const step = { stage: name, status: 'done', ms: Date.now() - started, ...describe(result) };
    trace.push(step);
    emit({ type: 'step', ...step });
    return result;
  };

  console.log('Processing question:', message, 'session:', sessionId, 'memory turns:', history.length);

  // Stage 1: route before any retrieval. Null means the router itself
  // failed (Groq error/bad JSON) — treat that like the old ungated flow.
  const routerResult = await stage('router', () => classifyIntent(message, history), r => ({
    intent: r?.intent || null,
    confidence: r?.confidence ?? null,
    usedMemory: history.length > 0
  }));
  const routerConfidence = routerResult?.confidence ?? null;

  // Stage 4a: critic pre-check — a deterministic backstop independent of
  // the router's LLM judgment. If it fires, it wins.
  const pre = await stage('critic_pre', async () => critic.preCheck(message, routerResult?.intent || null), r => ({
    override: r.override
  }));
  const intent = pre.intent;
  const preCheckOverride = pre.override;

  let botResponse, source, metadata, category, matchType, citations = [];
  const onToken = text => emit({ type: 'token', text });

  if (intent === 'urgent') {
    // Urgent-flag intents skip retrieval and generation entirely.
    await stage('retrieval', async () => null, () => ({ skipped: 'urgent — fixed crisis-resources reply' }));
    botResponse = URGENT_ESCALATION_MESSAGE;
    onToken(botResponse);
    source = 'router_escalation';
    matchType = 'escalation';
    category = null;
    metadata = { intent, confidence: routerConfidence };
  } else if (intent === 'out_of_scope') {
    // Out-of-scope intents also skip retrieval; answer with general knowledge only.
    const answer = await stage('retrieval', () => generateAnswer({ message, history, onToken }), () => ({ skipped: 'out of scope — no knowledge-base lookup' }));
    botResponse = answer || getIntelligentResponse(message);
    source = answer ? 'router_out_of_scope' : 'intelligent_response';
    matchType = 'fallback';
    category = null;
    metadata = { intent, confidence: routerConfidence };
    if (!answer) onToken(botResponse);
  } else {
    // In-scope intent (or router failed and intent is null) — hand off to
    // the retrieval agent.
    let retrieved = null;
    const result = await stage(
      'retrieval',
      () => retrievalAgent(message, intent, { history, onToken, onRetrieved: r => { retrieved = r; emit({ type: 'retrieved', ...r }); } }),
      r => ({ faqs: retrieved?.faqs || [], sources: retrieved?.sources || [], matchType: r.matchType, groqFailed: r.metadata?.error === 'groq_failed' })
    );
    botResponse = result.response;
    if (result.metadata?.error === 'groq_failed') onToken(botResponse);
    source = result.source;
    matchType = result.matchType;
    category = result.category;
    citations = result.citations;
    metadata = { ...result.metadata, confidence: routerConfidence };
  }

  // Stage 3: action agent — only runs for intents where a real incident
  // (not just an FAQ lookup) might need a ticket, email, or escalation.
  let actions = [];
  if (ACTION_AGENT_INTENTS.includes(intent)) {
    const actionResult = await stage('action', () => actionAgent(message, intent, category, sessionId, history), r => ({
      actions: r.actionsTaken.map(a => ({ tool: a.tool, ticketId: a.result?.ticketId || a.args?.ticketId || null, error: a.result?.error || null }))
    }));
    actions = actionResult.actionsTaken;
  } else {
    trace.push({ stage: 'action', status: 'skipped', reason: `intent "${intent}" never needs a ticket` });
    emit({ type: 'step', stage: 'action', status: 'skipped', reason: `intent "${intent}" never needs a ticket` });
  }

  // Stage 4b: critic review — runs before anything is sent, can annotate the
  // response and force an escalation the action agent didn't make.
  const reviewed = await stage('critic', () => applyCritic({ message, intent, routerConfidence, matchType, botResponse, actionsTaken: actions, preCheckOverride, sessionId }), r => ({
    flags: r.flags,
    reasoning: r.reasoning,
    forced: r.actionsTaken.filter(a => a.forcedByCritic).map(a => a.tool)
  }));
  botResponse = reviewed.response;
  actions = reviewed.actionsTaken;

  await db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [sessionId, 'bot', botResponse, now()]);
  const recent = await recentMessages(sessionId, 10);

  console.log('Sending response:', { source, category, preview: botResponse.substring(0, 100) + '...', criticFlags: reviewed.flags });

  return {
    response: botResponse,
    sessionId,
    history: recent,
    actions,
    criticFlags: reviewed.flags,
    source,
    category,
    matchType,
    intent,
    routerConfidence,
    citations,
    trace,
    memoryTurns: history.length,
    metadata
  };
}

// ---------------------------------------------------------------------------
// Staff auth: a shared bearer token (STAFF_TOKEN). With no token configured,
// staff routes are disabled rather than open — the critic log and tickets hold
// raw student messages, including crisis text.
// ---------------------------------------------------------------------------

function requireStaff(req, res, next) {
  const expected = process.env.STAFF_TOKEN;
  if (!expected) return res.status(503).json({ error: 'Staff dashboard is disabled: set STAFF_TOKEN on the server.' });
  const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const hash = s => crypto.createHash('sha256').update(s).digest();
  if (!provided || !crypto.timingSafeEqual(hash(provided), hash(expected))) {
    return res.status(401).json({ error: 'Invalid staff token' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  res.json({ message: 'Chatbot API is running!' });
});

app.get('/topics', (req, res) => {
  res.json({
    topics: topicCounts(),
    totalFAQs: Array.isArray(faqData) ? faqData.length : 0,
    totalSources: officialSources.length
  });
});

app.post('/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });
    res.json(await runPipeline({ message, sessionId }));
  } catch (error) {
    console.error('Error processing chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Same pipeline, streamed as newline-delimited JSON: session → step events as
// each stage starts/finishes → answer tokens → a final "done" with the full
// payload (which includes any critic edits to the streamed text).
app.post('/chat/stream', async (req, res) => {
  const { message, sessionId } = req.body || {};
  if (!message) return res.status(400).json({ error: 'Message is required' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const emit = event => {
    if (!res.writableEnded) res.write(JSON.stringify(event) + '\n');
  };

  try {
    const payload = await runPipeline({ message, sessionId, emit });
    emit({ type: 'done', payload });
  } catch (error) {
    console.error('Error processing streamed chat:', error);
    emit({ type: 'error', error: 'Internal server error' });
  }
  res.end();
});

// A session's own conversation, oldest first. Session ids are random UUIDs
// held only by that browser tab, so this doubles as its access check.
app.get('/history', async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ error: 'sessionId query param is required' });
  res.json({ history: await recentMessages(sessionId, 100) });
});

app.delete('/history', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
  await db.run('DELETE FROM messages WHERE session_id = ?', [sessionId]);
  res.json({ message: 'Chat history cleared for session', sessionId });
});

// The student's own tickets (not everyone's), with any staff replies.
app.get('/session/:sessionId/tickets', async (req, res) => {
  const rows = await db.all('SELECT * FROM tickets WHERE session_id = ? ORDER BY created_at DESC', [req.params.sessionId]);
  const tickets = [];
  for (const row of rows) {
    const replies = await db.all('SELECT id, author, content, created_at FROM ticket_replies WHERE ticket_id = ? ORDER BY id', [row.id]);
    tickets.push(formatTicket(row, replies));
  }
  res.json({ tickets });
});

// Staff replies newer than `after` (a message id), polled by the chat UI.
app.get('/session/:sessionId/updates', async (req, res) => {
  const after = Number(req.query.after) || 0;
  const updates = await db.all(
    "SELECT id, role, content, timestamp FROM messages WHERE session_id = ? AND role = 'staff' AND id > ? ORDER BY id",
    [req.params.sessionId, after]
  );
  res.json({ updates });
});

// --- Lease Checker ---------------------------------------------------------

const MAX_LEASE_CHARS = 120000;

async function extractPdfText(base64) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(base64, 'base64')));
  const { text, totalPages } = await extractText(pdf, { mergePages: true });
  return { text: text || '', pages: totalPages };
}

app.post('/lease/check', async (req, res) => {
  try {
    let { text, pdfBase64 } = req.body || {};
    let pages = null;

    if (pdfBase64) {
      const extracted = await extractPdfText(pdfBase64);
      text = extracted.text;
      pages = extracted.pages;
      if (text.replace(/\s/g, '').length < 50) {
        return res.status(422).json({ error: 'That PDF has no selectable text (it may be a scan). Paste the lease text instead.' });
      }
    }
    if (!text || text.trim().length < 50) return res.status(400).json({ error: 'Paste at least a few lines of the lease, or upload a PDF.' });

    const truncated = text.length > MAX_LEASE_CHARS;
    const result = await analyzeLease(text.slice(0, MAX_LEASE_CHARS), {
      complete: process.env.GROQ_API_KEY ? completeJSON : null,
      sourcesById
    });
    res.json({ ...result, pages, truncated, characters: Math.min(text.length, MAX_LEASE_CHARS) });
  } catch (error) {
    console.error('Lease check failed:', error);
    res.status(500).json({ error: 'Could not analyze that lease.' });
  }
});

// Hands a lease review to a person: opens a normal-priority ticket on the
// student's session with the flagged clauses as its summary.
app.post('/lease/escalate', async (req, res) => {
  try {
    const { sessionId: incoming, findings = [] } = req.body || {};
    if (!Array.isArray(findings) || findings.length === 0) return res.status(400).json({ error: 'No findings to send.' });
    const sessionId = incoming || crypto.randomUUID();
    await db.run('INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)', [sessionId, now()]);

    const lines = findings.slice(0, 20).map(f => `• [${f.severity}] ${f.title} (clause ${f.clauseNumber}): "${String(f.quote || '').slice(0, 200)}"`);
    const summary = `Lease review requested — ${findings.length} flagged clause(s).`;
    const ticket = await createTicketRecord({ category: 'lease_review', summary, priority: 'normal' }, lines.join('\n'), 'housing', sessionId);
    res.json({ sessionId, ...ticket });
  } catch (error) {
    console.error('Lease escalation failed:', error);
    res.status(500).json({ error: 'Could not create the ticket.' });
  }
});

// --- Listing Scam Checker --------------------------------------------------

app.post('/listing/check', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || text.trim().length < 30) return res.status(400).json({ error: 'Paste the listing or the landlord\'s message (at least a couple of sentences).' });
    const result = await analyzeListing(text.slice(0, 20000), {
      complete: process.env.GROQ_API_KEY ? completeJSON : null,
      sourcesById
    });
    res.json(result);
  } catch (error) {
    console.error('Listing check failed:', error);
    res.status(500).json({ error: 'Could not analyze that listing.' });
  }
});

// --- Staff (human-in-the-loop) ---------------------------------------------

const TICKET_STATUSES = ['open', 'escalated', 'in_progress', 'resolved'];

app.get('/staff/tickets', requireStaff, async (req, res) => {
  const rows = await db.all(`
    SELECT t.*, (SELECT COUNT(*) FROM ticket_replies r WHERE r.ticket_id = t.id) AS reply_count
    FROM tickets t
    ORDER BY CASE WHEN t.status = 'resolved' THEN 1 ELSE 0 END, t.escalated DESC, t.created_at DESC
  `);
  res.json({ tickets: rows.map(r => formatTicket(r)) });
});

app.get('/staff/tickets/:id', requireStaff, async (req, res) => {
  const row = await findTicket(req.params.id);
  if (!row) return res.status(404).json({ error: 'Ticket not found' });
  const replies = await db.all('SELECT id, author, content, created_at FROM ticket_replies WHERE ticket_id = ? ORDER BY id', [row.id]);
  const conversation = await recentMessages(row.session_id, 50);
  const criticLog = (await db.all('SELECT * FROM critic_log WHERE session_id = ? ORDER BY id DESC LIMIT 20', [row.session_id]))
    .map(({ flags_json, ...entry }) => ({ ...entry, flags: JSON.parse(flags_json) }));
  res.json({ ticket: formatTicket(row, replies), conversation, criticLog });
});

app.post('/staff/tickets/:id/reply', requireStaff, async (req, res) => {
  const content = String(req.body?.content || '').trim();
  const author = String(req.body?.author || 'OCC staff').trim().slice(0, 60) || 'OCC staff';
  if (!content) return res.status(400).json({ error: 'Reply text is required' });

  const ticket = await findTicket(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

  await db.run('INSERT INTO ticket_replies (ticket_id, author, content, created_at) VALUES (?, ?, ?, ?)', [ticket.id, author, content, now()]);
  // Mirrored into the student's conversation so their open chat picks it up.
  await db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [ticket.session_id, 'staff', `**${author}** (re: ${ticket.id}): ${content}`, now()]);
  if (ticket.status !== 'resolved') await db.run('UPDATE tickets SET status = ? WHERE id = ?', ['in_progress', ticket.id]);
  res.json({ ok: true });
});

app.patch('/staff/tickets/:id', requireStaff, async (req, res) => {
  const { status } = req.body || {};
  if (!TICKET_STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${TICKET_STATUSES.join(', ')}` });
  const result = await db.run('UPDATE tickets SET status = ? WHERE id = ?', [status, req.params.id]);
  if (!result.changes) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ok: true, status });
});

// Every critic decision, fired or not — the raw material for the eval set.
// Staff-only: rows contain students' raw messages.
app.get('/staff/critic-log', requireStaff, async (req, res) => {
  const rows = await db.all('SELECT * FROM critic_log ORDER BY id DESC LIMIT 500');
  res.json({ criticLog: rows.map(({ flags_json, ...row }) => ({ ...row, flags: JSON.parse(flags_json) })) });
});

// Old public paths, now behind the staff token.
app.get('/tickets', requireStaff, (_req, res) => res.redirect(307, '/staff/tickets'));
app.get('/critic-log', requireStaff, (_req, res) => res.redirect(307, '/staff/critic-log'));

app.use((error, req, res, next) => {
  console.error('Unhandled route error:', error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
