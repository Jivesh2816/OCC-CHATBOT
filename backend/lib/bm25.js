// Minimal Okapi BM25 over a fixed in-memory corpus. The corpus is small
// (tens to low hundreds of passages), so a full scan per query is cheap and
// there is no index to keep in sync. Lexical, not semantic: it ranks by term
// overlap weighted by rarity, so it won't match synonyms the way embeddings
// would — but it needs no embedding provider and its scores are explainable.

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'my', 'no', 'not',
  'of', 'on', 'or', 'our', 'so', 'that', 'the', 'their', 'them', 'there', 'they', 'this', 'to',
  'was', 'we', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'you', 'your',
  'i\'m', 'am', 'should', 'would', 'could', 'about', 'any', 'all', 'just', 'get', 'got'
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s-]/g, ' ')
    .split(/[\s-]+/)
    .map(t => t.replace(/^'+|'+$/g, ''))
    // crude plural folding so "leases" matches "lease" and "landlords" matches "landlord"
    .map(t => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t))
    // bare numbers are mostly section labels ("10. Smoking"), i.e. noise
    .filter(t => t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function createIndex(docs, getText, { k1 = 1.5, b = 0.75 } = {}) {
  const tokenized = docs.map(d => tokenize(getText(d)));
  const avgLen = tokenized.reduce((sum, t) => sum + t.length, 0) / Math.max(tokenized.length, 1);

  const docFreq = new Map();
  for (const tokens of tokenized) {
    for (const term of new Set(tokens)) docFreq.set(term, (docFreq.get(term) || 0) + 1);
  }
  const N = docs.length;
  const idf = term => {
    const df = docFreq.get(term) || 0;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  };

  function search(query, { topN = 3, minScore = 0, filter = null } = {}) {
    const queryTerms = [...new Set(tokenize(query))];
    if (queryTerms.length === 0) return [];

    const results = [];
    tokenized.forEach((tokens, i) => {
      if (filter && !filter(docs[i])) return;
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

      let score = 0;
      for (const term of queryTerms) {
        const f = tf.get(term);
        if (!f) continue;
        score += idf(term) * (f * (k1 + 1)) / (f + k1 * (1 - b + b * tokens.length / avgLen));
      }
      if (score > minScore) results.push({ doc: docs[i], score });
    });

    return results.sort((a, b2) => b2.score - a.score).slice(0, topN);
  }

  return { search };
}

module.exports = { createIndex, tokenize };
