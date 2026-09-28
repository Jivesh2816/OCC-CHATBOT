const test = require('node:test');
const assert = require('node:assert/strict');
const { createIndex, tokenize } = require('../lib/bm25');
const sources = require('../sources/official.json');

test('tokenize drops stopwords and folds simple plurals', () => {
  assert.deepEqual(tokenize('What are my rights as tenants?'), ['right', 'tenant']);
});

test('ranks documents by term rarity, not raw overlap', () => {
  const docs = [
    { id: 'a', text: 'rent rent rent rent' },
    { id: 'b', text: 'rent sublet' },
    { id: 'c', text: 'transit bus' }
  ];
  const index = createIndex(docs, d => d.text);
  assert.equal(index.search('how do I sublet', { topN: 1 })[0].doc.id, 'b');
  assert.deepEqual(index.search('groceries'), []);
});

// Retrieval sanity checks against the real passage set: the passage a
// student most needs should rank in the top 3 for a plain-language question.
const index = createIndex(sources, s => `${s.heading} ${s.text}`);
const top3 = q => index.search(q, { topN: 3 }).map(r => r.doc.id);

for (const [question, ...acceptable] of [
  ['my landlord keeps entering my unit without notice', 'know-your-rights-5'],
  ['how much deposit can a landlord ask for', 'know-your-rights-2'],
  ['can my landlord ban pets or guests in the lease', 'guide-ontarios-standard-lease-17'],
  ['how much can my rent go up this year', 'renting-ontario-your-rights-2'],
  // either UW page on rental fraud is a correct answer here
  ['I think a rental listing is a scam', 'frauds-and-scams-1', 'help-waterloo-7']
]) {
  test(`retrieves ${acceptable.join(' or ')} for "${question}"`, () => {
    assert.ok(top3(question).some(id => acceptable.includes(id)), `top 3 were ${top3(question)}`);
  });
}
