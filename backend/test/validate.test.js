const test = require('node:test');
const assert = require('node:assert/strict');
const { isSessionId, parseChatMessage, MAX_MESSAGE_CHARS } = require('../lib/validate');

test('only server-style random UUIDs are accepted as session ids', () => {
  assert.equal(isSessionId('5397440e-f762-4bd9-818b-cea8f1b1ce32'), true);
  for (const bad of ['1', 'test', '', null, undefined, 42, { id: 1 }, '5397440e-f762-4bd9-818b-cea8f1b1ce32; DROP TABLE']) {
    assert.equal(isSessionId(bad), false, String(bad));
  }
});

test('chat messages must be non-empty strings under the length cap', () => {
  assert.deepEqual(parseChatMessage({ message: '  hi  ' }), { message: 'hi' });
  for (const body of [{}, { message: '   ' }, { message: { a: 1 } }, { message: 12345 }, null]) {
    assert.ok(parseChatMessage(body).error, JSON.stringify(body));
  }
  assert.match(parseChatMessage({ message: 'a'.repeat(MAX_MESSAGE_CHARS + 1) }).error, /under/);
});
