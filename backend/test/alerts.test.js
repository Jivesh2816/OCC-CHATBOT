const test = require('node:test');
const assert = require('node:assert/strict');
const { alertChannels, sendEscalationAlert } = require('../lib/alerts');

const ticket = {
  id: 'T-abc12345',
  category: 'safety_concern',
  priority: 'urgent',
  original_message: 'someone is stalking me on my walk home'
};

test('no channels configured → nothing sent, nothing thrown', async () => {
  assert.deepEqual(alertChannels({}), []);
  const result = await sendEscalationAlert(ticket, 'critic override', { env: {} });
  assert.deepEqual(result.sent, []);
  assert.match(result.skipped, /no alert channel/);
});

test('email needs both SMTP_URL and STAFF_ALERT_EMAIL', () => {
  assert.deepEqual(alertChannels({ SMTP_URL: 'smtps://x' }), []);
  assert.deepEqual(alertChannels({ SMTP_URL: 'smtps://x', STAFF_ALERT_EMAIL: 'a@b.c' }), ['email']);
});

test('Slack webhook gets {text}; the alert never includes the student\'s message', async () => {
  let captured;
  const fetchImpl = async (url, init) => { captured = { url, body: JSON.parse(init.body) }; return { ok: true }; };
  const env = { STAFF_ALERT_WEBHOOK_URL: 'https://hooks.slack.com/services/X', STAFF_DASHBOARD_URL: 'https://example.test/#/staff' };

  const result = await sendEscalationAlert(ticket, 'Critic override: urgent message must reach a human.', { env, fetchImpl });
  assert.deepEqual(result.sent, ['webhook']);
  assert.match(captured.body.text, /URGENT ticket T-abc12345/);
  assert.match(captured.body.text, /example\.test\/#\/staff/);
  assert.doesNotMatch(captured.body.text, /stalking/);
  assert.match(captured.body.text, /Escalated by: critic/);
});

test('the agent-written escalation reason is left out too (it paraphrases the message)', async () => {
  let body;
  const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return { ok: true }; };
  await sendEscalationAlert(ticket, 'Student reports being stalked on the walk home', { env: { STAFF_ALERT_WEBHOOK_URL: 'https://hooks.slack.com/x' }, fetchImpl });
  assert.doesNotMatch(body.text, /stalked/);
  assert.match(body.text, /Escalated by: action agent/);
});

test('Discord webhook gets {content}', async () => {
  let body;
  const fetchImpl = async (url, init) => { body = JSON.parse(init.body); return { ok: true }; };
  await sendEscalationAlert(ticket, 'r', { env: { STAFF_ALERT_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/x' }, fetchImpl });
  assert.ok(body.content && !body.text);
});

test('a failing channel is reported, not thrown, and others still send', async () => {
  const fetchImpl = async () => ({ ok: false, status: 500 });
  const mailer = { sendMail: async () => ({}) };
  const env = { STAFF_ALERT_WEBHOOK_URL: 'https://hooks.slack.com/x', SMTP_URL: 'smtps://x', STAFF_ALERT_EMAIL: 'staff@example.test' };
  const result = await sendEscalationAlert(ticket, 'r', { env, fetchImpl, mailer });
  assert.deepEqual(result.sent, ['email']);
  assert.deepEqual(result.failed, ['webhook']);
});
