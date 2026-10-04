const test = require('node:test');
const assert = require('node:assert/strict');
const { detectCrisis, urgentReply } = require('../lib/crisis');

// Real ways students write about a crisis. Each must be caught without the
// model, since this check is what still works during an outage.
const CRISIS = [
  ['I want to kill myself', 'self_harm'],
  ['i want to end it all, nothing matters anymore', 'self_harm'],
  ['kms lol no seriously i cant do this', 'self_harm'],
  ['I dont want to be alive anymore', 'self_harm'],
  ['thinking about ending things', 'self_harm'],
  ['I took a bunch of pills', 'self_harm'],
  ['i don’t want to wake up tomorrow', 'self_harm'],
  ['Suicidal', 'self_harm'],
  ['i was raped at a party', 'sexual_violence'],
  ['someone spiked my drink last night', 'sexual_violence'],
  ['my boyfriend hits me and im scared to go home tonight', 'violence'],
  ['my partner hit me last night', 'violence'],
  ['my roommate beats me', 'violence'],
  ['he pushed me down the stairs', 'violence'],
  ['my landlord threatened to hurt me', 'violence'],
  ['I am scared my partner will kill me', 'violence'],
  ['I am in danger', 'danger'],
  ['I feel unsafe at home', 'danger'],
  ['someone broke into my apartment and is still here', 'danger'],
  ['my ex is following me home every night', 'danger'],
  ['im homeless tonight and have nowhere to sleep', 'housing_emergency'],
  ['my landlord changed the locks while I was at class and put my stuff on the curb', 'housing_emergency'],
  ['I got locked out by my landlord and its -20 outside, I have nowhere to go', 'housing_emergency'],
  // A look-alike elsewhere in the message must not hide a real crisis: vetoes
  // cancel only the phrase they overlap.
  ['I went to a suicide prevention workshop but I still want to kill myself', 'self_harm'],
  ["I'm homeless, is there a homeless shelter near campus?", 'housing_emergency'],
  ['I have been stockpiling my meds', 'self_harm'],
  ['I think I was drugged at the bar last night', 'sexual_violence'],
  ['he threw plates at me again', 'violence']
];

// Look-alikes that must not trigger a crisis response.
const NOT_CRISIS = [
  'what suicide prevention resources does UW have?',
  'my roommate keeps saying he wants to die when the wifi drops lol',
  'is it legal if my landlord hit me with a rent increase?',
  'my landlord hit me with a surprise fee',
  'does the lease say I am in danger of losing my deposit?',
  "the heater is broken, I don't feel safe leaving it on",
  'can my landlord kick me out for a party?',
  'my landlord is pushing me to sign a new lease',
  'I want to end my lease early',
  'what happens if I get evicted?',
  'How do I sublet my room?',
  // Information-seeking uses of crisis words.
  'Does UW run sexual assault prevention training?',
  'How can I volunteer at a homeless shelter?',
  'lots of people started following me on instagram',
  'I locked myself out of my apartment, where is a locksmith?',
  'Can I park on the street overnight?',
  // Kept out of the rules on purpose (hyperbole as often as not); the router judges these.
  "My prof said he'd kill me if I'm late lol"
];

for (const [message, category] of CRISIS) {
  test(`detects ${category}: "${message}"`, () => {
    assert.equal(detectCrisis(message)?.id, category);
  });
}

for (const message of NOT_CRISIS) {
  test(`does not flag: "${message}"`, () => {
    assert.equal(detectCrisis(message), null);
  });
}

test('housing emergencies are not treated as a crisis that replaces the answer', () => {
  assert.equal(detectCrisis('I have nowhere to sleep tonight').urgent, false);
  assert.equal(detectCrisis('I want to die').urgent, true);
});

test('urgent replies carry resources for the kind of crisis', () => {
  assert.match(urgentReply('violence'), /Women's Crisis Services/);
  assert.match(urgentReply('self_harm'), /988/);
  assert.match(urgentReply('sexual_violence'), /Sexual Assault Support Centre/);
  // A router-flagged urgent message with no pattern match gets the general list.
  assert.match(urgentReply(undefined), /988/);
});

test('urgent replies only promise a person when staff are actually alerted', () => {
  assert.doesNotMatch(urgentReply('self_harm', { staffHandoff: false }), /flagged this conversation for staff/);
  assert.match(urgentReply('self_harm', { staffHandoff: true }), /flagged this conversation for staff/);
});
