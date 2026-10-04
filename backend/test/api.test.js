// The HTTP surface, in-process on an ephemeral port with a scripted model:
// request validation, the error handler, session guards, and staff auth.
const fake = require('./helpers/fake-groq');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.STAFF_TOKEN = 'test-staff-token';
const app = require('../app');

let server;
let base;
test.before(async () => {
  server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (route, body, headers = {}) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body)
});

test('POST /chat rejects malformed input with 4xx before any model call', async () => {
  const calls = fake.install(() => { throw new Error('model must not be called'); });
  const cases = [
    [{}, 400],
    [{ message: '' }, 400],
    [{ message: '   ' }, 400],
    [{ message: 12345 }, 400],
    [{ message: ['a'] }, 400],
    [{ message: 'x'.repeat(2001) }, 400],
    ['{"message": "unterminated', 400],
    [{ message: 'y'.repeat(150_000) }, 413]
  ];
  for (const [body, status] of cases) {
    const res = await post('/chat', body);
    assert.equal(res.status, status, `body ${JSON.stringify(body).slice(0, 40)}`);
    assert.ok((await res.json()).error);
  }
  assert.equal(calls.length, 0);
});

test('POST /chat answers a valid message and mints a UUID session', async () => {
  fake.install(stage => (stage === 'router' ? fake.routerReply('transit') : 'Take the ION.'));
  const res = await post('/chat', { message: 'How do I get to Uptown?' });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.intent, 'transit');
  assert.match(data.sessionId, /^[0-9a-f-]{36}$/);
  // The request id in the header matches the payload (and the log line).
  assert.equal(res.headers.get('x-request-id'), data.requestId);
  assert.equal(data.response, 'Take the ION.');
});

test('an unrecognised session id starts a fresh session instead of being trusted', async () => {
  fake.install(stage => (stage === 'router' ? fake.routerReply('food') : 'Try the food bank.'));
  const res = await post('/chat', { message: 'food bank?', sessionId: '../../etc/passwd' });
  const data = await res.json();
  assert.notEqual(data.sessionId, '../../etc/passwd');
  assert.match(data.sessionId, /^[0-9a-f-]{36}$/);
});

test('POST /chat/stream emits session, step, token and done events as NDJSON', async () => {
  fake.install(stage => (stage === 'router' ? fake.routerReply('bylaws') : 'Quiet hours start at 11pm.'));
  const res = await post('/chat/stream', { message: 'noise bylaw hours?' });
  assert.equal(res.status, 200);
  const events = (await res.text()).trim().split('\n').map(line => JSON.parse(line));
  const types = events.map(e => e.type);
  assert.equal(types[0], 'session');
  assert.ok(types.includes('step'));
  assert.ok(types.includes('token'));
  assert.equal(types.at(-1), 'done');
  assert.equal(events.at(-1).payload.intent, 'bylaws');
});

test('session routes reject ids that are not UUIDs', async () => {
  assert.equal((await fetch(`${base}/history?sessionId=1`)).status, 400);
  assert.equal((await fetch(`${base}/session/not-a-uuid/tickets`)).status, 400);
  assert.equal((await fetch(`${base}/session/1/updates`)).status, 400);
});

test('staff routes require the token', async () => {
  assert.equal((await fetch(`${base}/staff/tickets`)).status, 401);
  assert.equal((await fetch(`${base}/staff/tickets`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  const ok = await fetch(`${base}/staff/tickets`, { headers: { Authorization: 'Bearer test-staff-token' } });
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray((await ok.json()).tickets));
  // The old public paths stay behind the token too.
  assert.equal((await fetch(`${base}/critic-log`, { redirect: 'manual' })).status, 401);
});

test('an unexpected pipeline error returns a generic 500, not a stack trace', async () => {
  const { db } = require('../db');
  const original = db.run;
  db.run = async () => { throw new Error('disk on fire'); };
  try {
    const res = await post('/chat', { message: 'hello there' });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.error, 'Internal server error');
    assert.doesNotMatch(JSON.stringify(body), /disk on fire/);
  } finally {
    db.run = original;
  }
});
