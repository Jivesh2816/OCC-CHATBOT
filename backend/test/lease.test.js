const test = require('node:test');
const assert = require('node:assert/strict');
const { RULES, splitClauses, detectWithRules, analyzeLease } = require('../lib/lease');
const sources = require('../sources/official.json');

const sourcesById = Object.fromEntries(sources.map(s => [s.id, s]));

const rulesFor = text => detectWithRules(splitClauses(text)).map(h => h.ruleId);

test('every rule cites passages that exist in the official source set', () => {
  for (const rule of RULES) {
    assert.ok(rule.sourceIds.length > 0, `${rule.id} has no sources`);
    for (const id of rule.sourceIds) assert.ok(sourcesById[id], `${rule.id} cites missing passage ${id}`);
  }
});

test('flags the void clauses listed in the standard-lease guide', () => {
  assert.deepEqual(rulesFor('No pets are allowed on the premises.'), ['no_pets']);
  assert.deepEqual(rulesFor('Overnight guests are not permitted.'), ['no_guests']);
  assert.ok(rulesFor('Tenant shall pay a damage deposit of $500.').includes('prohibited_fees'));
  assert.deepEqual(rulesFor('A late fee of $50 applies to rent paid after the 1st.'), ['late_penalty']);
  assert.deepEqual(rulesFor('The tenant is responsible for all repairs to the unit.'), ['tenant_repairs']);
  assert.deepEqual(rulesFor('The landlord may enter the unit at any time.'), ['entry_without_notice']);
  assert.deepEqual(rulesFor('Subletting is strictly prohibited.'), ['no_sublet']);
  assert.deepEqual(rulesFor('The landlord reserves the right to inspect the premises at any time.'), ['entry_without_notice']);
  assert.deepEqual(rulesFor('The tenant shares the kitchen and bathroom with the owner.'), ['shared_with_owner']);
});

test('keeps very short clauses like "No pets."', () => {
  assert.deepEqual(rulesFor('3. No pets.\n4. Rent is due on the first.'), ['no_pets']);
});

test('does not flag lawful versions of the same topics', () => {
  assert.deepEqual(rulesFor('The tenant must pay for any repairs to damage caused by the tenant or their guests.'), []);
  assert.deepEqual(rulesFor('In an emergency the landlord may enter at any time.'), []);
  assert.deepEqual(rulesFor('The tenant shall not sublet without the landlord\'s written consent.'), []);
  assert.deepEqual(rulesFor('The carpet will be professionally cleaned before move-in.'), []);
  assert.deepEqual(rulesFor('A refundable key deposit of $50 is required.'), []);
});

test('marks deposits and shared-kitchen arrangements as "check", not void', () => {
  const lease = 'A last month\'s rent deposit of $900 is due at signing. The tenant will share the kitchen with the owner, who lives in the house.';
  const { findings } = { findings: detectWithRules(splitClauses(lease)) };
  const ids = findings.map(f => f.ruleId);
  assert.ok(ids.includes('deposit_limit'));
  assert.ok(ids.includes('shared_with_owner'));
});

test('analyzeLease merges rule and model hits and drops invalid model output', async () => {
  const lease = 'Rent is $900 per month.\nNo pets allowed.\nTenant agrees to keep the unit tidy at all times and pay $100 if it is messy.';
  // The model agrees on clause 1, adds a real rule on clause 2, and also
  // returns an out-of-range clause and an unknown rule — both must be dropped.
  const complete = async () => JSON.stringify({ findings: [
    { clause: 1, rule: 'no_pets' },
    { clause: 2, rule: 'late_penalty' },
    { clause: 99, rule: 'no_pets' },
    { clause: 0, rule: 'made_up_rule' }
  ] });

  const result = await analyzeLease(lease, { complete, sourcesById });
  const pets = result.findings.find(f => f.ruleId === 'no_pets');
  assert.deepEqual(pets.detectedBy.sort(), ['model', 'rules']);
  assert.equal(pets.quote, 'No pets allowed.');
  assert.ok(pets.sources.every(s => s.url.startsWith('https://')));

  const modelOnly = result.findings.find(f => f.ruleId === 'late_penalty');
  assert.deepEqual(modelOnly.detectedBy, ['model']);
  assert.equal(result.findings.length, 2);
});

test('analyzeLease still returns rule findings when the model call fails', async () => {
  const complete = async () => { throw new Error('rate limited'); };
  const result = await analyzeLease('No guests allowed after 11pm.', { complete, sourcesById });
  assert.equal(result.findings[0].ruleId, 'no_guests');
  assert.equal(result.summary.modelError, 'rate limited');
});
