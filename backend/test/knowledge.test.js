const test = require('node:test');
const assert = require('node:assert/strict');
const { findRelevantFAQs, searchFAQ, getIntelligentResponse } = require('../lib/knowledge');

test('unrelated or empty questions match no FAQ', () => {
  // The old scorer counted shared words like "the" and "and" as a match, so
  // these all came back labelled as grounded in an FAQ.
  assert.deepEqual(findRelevantFAQs('asdf qwer the and for', 3, 'Housing & Leases'), []);
  assert.deepEqual(findRelevantFAQs('what is the weather on mars', 3, 'Housing & Leases'), []);
  assert.deepEqual(findRelevantFAQs('What is the OCC office phone number and opening hours?', 3, 'Housing & Leases'), []);
  assert.deepEqual(findRelevantFAQs('I have nowhere to sleep tonight', 3, 'Housing & Leases'), []);
});

test('real questions still find their FAQ', () => {
  const top = (q, category) => findRelevantFAQs(q, 3, category)[0]?.question;
  assert.equal(top("My landlord won't fix maintenance issues", 'Housing & Leases'), "My landlord won't fix maintenance issues");
  assert.equal(top('my heater is broken and my landlord ignores me', 'Housing & Leases'), "My landlord won't fix maintenance issues");
  assert.equal(top('What are the noise bylaw hours in Waterloo?', 'Neighbours & Bylaws'), 'Noise rules in Kitchener vs Waterloo');
  assert.equal(top('Where can I get a mental health counselor off campus?', 'Health & Safety'), 'Mental health resources');
});

test('a verbatim fallback answer needs a clearer match than model context does', () => {
  assert.ok(findRelevantFAQs('Where can I find a food bank near campus?', 3, 'Food & Essentials').length > 0);
  assert.equal(searchFAQ('Where can I find a food bank near campus?', 'Food & Essentials'), null);
  assert.equal(searchFAQ("My landlord won't fix maintenance issues", 'Housing & Leases')?.question, "My landlord won't fix maintenance issues");
});

test('the no-model fallback says no answer was generated and always carries crisis numbers', () => {
  for (const message of ['hello', 'my boyfriend hits me', 'where can I eat']) {
    const reply = getIntelligentResponse(message);
    assert.match(reply, /temporarily unavailable/);
    assert.match(reply, /911/);
    assert.match(reply, /988/);
    assert.doesNotMatch(reply, /Happy to help/);
  }
});
