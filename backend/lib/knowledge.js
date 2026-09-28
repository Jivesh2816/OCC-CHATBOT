// The knowledge base: 42 curated FAQs plus 125 official passages, and the
// lookups over them (FAQ scoring, BM25 over passages, citation helpers).
const fs = require('fs');
const path = require('path');
const { createIndex } = require('./bm25');

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

module.exports = {
  faqCount: () => (Array.isArray(faqData) ? faqData.length : 0),
  officialSources,
  sourcesById,
  searchFAQ,
  topicCounts,
  getIntelligentResponse,
  findRelevantFAQs,
  findOfficialSources,
  normalizeCitations,
  toCitations
};
