// The knowledge base: 42 curated FAQs plus 125 official passages, and the
// lookups over them (FAQ scoring, BM25 over passages, citation helpers).
const fs = require('fs');
const path = require('path');
const { createIndex } = require('./bm25');
const { SAFETY_FOOTER } = require('./crisis');

// Load FAQ data
let faqData = {};
try {
  const faqPath = path.join(__dirname, '..', 'faq.json');
  const faqRaw = fs.readFileSync(faqPath, 'utf8');
  faqData = JSON.parse(faqRaw);
  console.log('FAQ data loaded successfully');
} catch (error) {
  console.error('Error loading FAQ data:', error);
}

// Official passages (UW Off-Campus Housing, Government of Ontario, UW Special
// Constable Service), scraped by scripts/build-sources.js and committed, so
// answers can cite a real page instead of the model's memory.
const officialSources = require('../sources/official.json');
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
  enter: 'entry notice', entering: 'entry notice', barge: 'entry notice',
  break: 'terminate termination', breaking: 'terminate termination'
};
const PHRASE_SYNONYMS = [
  [/\bget out of (my|the|a) (lease|contract)\b/, 'terminate termination'],
  [/\bmove out early\b/, 'terminate termination']
];
function expandQuery(query) {
  const lower = query.toLowerCase();
  const extra = lower.split(/[^a-z']+/).map(w => QUERY_SYNONYMS[w]).filter(Boolean);
  for (const [pattern, words] of PHRASE_SYNONYMS) if (pattern.test(lower)) extra.push(words);
  return extra.length ? `${query} ${extra.join(' ')}` : query;
}

// FAQ retrieval: BM25 over each entry's question (counted twice, since it's
// the best summary of the entry) plus its answer. Scores below the threshold
// are treated as no match. The old word-overlap scorer counted any shared
// three-letter word ("the", "and") as a hit, so almost every question — even
// "asdf the and for" — came back "grounded in an FAQ".
//
// Thresholds were set against eval-set.json and a list of off-topic
// questions: genuine matches score ~5–19, unrelated questions under ~4.
const FAQ_MIN_SCORE = 5;
// Serving an FAQ answer verbatim (model unavailable) needs a clearer match.
const FAQ_VERBATIM_MIN_SCORE = 8;
const allFAQs = () => (Array.isArray(faqData) ? faqData : []);
const faqIndex = createIndex(allFAQs(), f => `${f.question} ${f.question} ${f.answer}`);

function scoredFAQs(question, { topN = 3, category = null, minScore = FAQ_MIN_SCORE } = {}) {
  return faqIndex.search(expandQuery(question), {
    topN,
    minScore,
    filter: category ? f => f.category === category : null
  });
}

// Best single FAQ to show as-is when the model is unavailable, or null.
function searchFAQ(userMessage, category = null) {
  return scoredFAQs(userMessage, { topN: 1, category, minScore: FAQ_VERBATIM_MIN_SCORE })[0]?.doc || null;
}

// The 6 topics surfaced in the sidebar/welcome UI. Academic and Clubs & Social
// FAQs still exist and are tagged, but aren't promoted as a nav entry point.
const NAV_TOPICS = ['Housing & Leases', 'Rent & Money', 'Getting Around', 'Health & Safety', 'Food & Essentials', 'Neighbours & Bylaws'];

function topicCounts() {
  return NAV_TOPICS.map(name => ({
    name,
    count: allFAQs().filter(f => f.category === name).length
  }));
}

// Last-resort reply when the model is unavailable and no FAQ matched. It says
// plainly that no answer was generated, points somewhere real, and always
// carries crisis numbers — this is what a struggling student sees during an
// outage, so it must never read as a cheerful non-answer.
function getIntelligentResponse(message) {
  const q = String(message || '').toLowerCase();
  let pointer = 'For housing and off-campus questions, the UW Off-Campus Housing website (uwaterloo.ca/off-campus-housing) is the best place to start.';
  if (/(lease|landlord|rent|tenant|evict|deposit|sublet)/.test(q)) pointer = 'For leases and tenant rights, see uwaterloo.ca/off-campus-housing or ontario.ca/page/renting-ontario-your-rights.';
  else if (/(food|meal|eat|grocer|hungry)/.test(q)) pointer = 'For food support, WUSA runs food programs for students — see wusa.ca.';
  else if (/(bus|ion|grt|transit|u-?pass)/.test(q)) pointer = 'For transit, see grt.ca; your WatCard works as your U-Pass.';
  else if (/(health|doctor|clinic|counsel|mental|anxious|depress|stress)/.test(q)) pointer = 'For health and counselling, see UW Campus Wellness (uwaterloo.ca/campus-wellness), or Good2Talk at 1-866-925-5454 (24/7).';
  return `I can't generate an answer right now — the AI model is temporarily unavailable. Please try again in a few minutes.

${pointer}${SAFETY_FOOTER}`;
}

// Function to find top N relevant FAQs for context.
// When category is given (from the router's intent), matching is restricted
// to that category instead of running over all entries.
function findRelevantFAQs(question, topN = 3, category = null) {
  return scoredFAQs(question, { topN, category }).map(r => r.doc);
}

// Official passages relevant to the question, ranked by BM25, as { doc, score }.
function scoredOfficialSources(query, intent, { topN = 3, minScore = SOURCE_MIN_SCORE } = {}) {
  if (!SOURCE_INTENTS.has(intent)) return [];
  return sourceIndex.search(expandQuery(query), { topN, minScore });
}

function findOfficialSources(query, intent, topN = 3) {
  return scoredOfficialSources(query, intent, { topN }).map(r => r.doc);
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

module.exports = {
  allFAQs,
  faqCount: () => (Array.isArray(faqData) ? faqData.length : 0),
  officialSources,
  sourcesById,
  searchFAQ,
  topicCounts,
  getIntelligentResponse,
  findRelevantFAQs,
  findOfficialSources,
  // Scored forms of the two lookups, for the eval and the request log.
  scoredFAQs,
  scoredOfficialSources,
  expandQuery,
  SOURCE_INTENTS,
  FAQ_MIN_SCORE,
  SOURCE_MIN_SCORE,
  normalizeCitations,
  toCitations
};
