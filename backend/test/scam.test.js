const test = require('node:test');
const assert = require('node:assert/strict');
const { SIGNALS, detectWithRules, checkPrice, analyzeListing } = require('../lib/scam');
const sources = require('../sources/official.json');

const sourcesById = Object.fromEntries(sources.map(s => [s.id, s]));

test('every signal cites passages that exist in the official source set', () => {
  for (const signal of SIGNALS) {
    for (const id of signal.sourceIds) assert.ok(sourcesById[id], `${signal.id} cites missing passage ${id}`);
  }
});

test('classic overseas-landlord scam scores high risk', async () => {
  const listing = 'Beautiful 2 bedroom apartment near UW, $700/month. I am currently out of the country for work so I cannot show the unit. Please send the first month by Western Union to hold it and I will courier the keys to you.';
  const result = await analyzeListing(listing, { complete: null, sourcesById });
  const ids = result.signals.map(s => s.id);
  assert.equal(result.risk.level, 'high');
  for (const id of ['untraceable_payment', 'pay_before_viewing', 'overseas_landlord', 'below_market']) {
    assert.ok(ids.includes(id), `expected ${id} in ${ids}`);
  }
});

test('an ordinary listing scores low risk', async () => {
  const listing = 'Room in a shared house on Columbia St, $850/month plus utilities. Viewings available weekday evenings — message me to book a time. Standard Ontario lease, last month\'s rent deposit.';
  const result = await analyzeListing(listing, { complete: null, sourcesById });
  assert.equal(result.risk.level, 'low');
  assert.deepEqual(result.signals, []);
});

test('price check compares against UW\'s estimate for the matching unit type', () => {
  assert.equal(checkPrice('Basement unit for $500 a month').belowMarket, true);
  assert.equal(checkPrice('Basement unit for $1,150 per month').belowMarket, false);
  assert.equal(checkPrice('Nice place, message me'), null);
});

test('model signals are kept only when their quote really appears in the listing', async () => {
  const listing = 'Studio downtown for $1000. Lots of other students are interested so act fast!';
  const complete = async () => JSON.stringify({ signals: [
    { id: 'urgency', quote: 'act fast' },
    { id: 'overpayment', quote: 'send the difference back' }, // not in the text
    { id: 'below_market', quote: '$1000' } // computed-only signal; model may not set it
  ] });
  const result = await analyzeListing(listing, { complete, sourcesById });
  assert.deepEqual(result.signals.map(s => s.id), ['urgency']);
  assert.deepEqual(result.signals[0].detectedBy.sort(), ['model', 'rules']);
});

test('rule detection quotes the sentence that triggered it', () => {
  const [hit] = detectWithRules('Great place. Payment in bitcoin only. Thanks.');
  assert.equal(hit.signalId, 'untraceable_payment');
  assert.equal(hit.quote, 'Payment in bitcoin only.');
});
