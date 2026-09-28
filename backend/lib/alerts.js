// Staff alerts for escalated tickets. A ticket in a queue nobody is watching
// isn't a handoff to a human, so every escalation pings a real channel:
//
//   STAFF_ALERT_WEBHOOK_URL  Slack or Discord incoming webhook
//   SMTP_URL + STAFF_ALERT_EMAIL  email via any SMTP server (smtps://user:pass@host)
//
// Alerts carry ticket metadata and a dashboard link, never the student's
// message — and not the escalation reason either, since the action agent
// writes that and it usually paraphrases the message. Crisis text shouldn't
// sit in a chat channel or inbox; staff read it in the token-protected dashboard.

const ALERT_TIMEOUT_MS = 4000;

function alertChannels(env = process.env) {
  const channels = [];
  if (env.STAFF_ALERT_WEBHOOK_URL) channels.push('webhook');
  if (env.SMTP_URL && env.STAFF_ALERT_EMAIL) channels.push('email');
  return channels;
}

function formatAlert(ticket, reason, dashboardUrl) {
  const urgent = ticket.priority === 'urgent';
  const title = `${urgent ? '🚨 URGENT' : '⚠️ Escalated'} ticket ${ticket.id} — ${ticket.category || 'general'} (${ticket.priority || 'normal'})`;
  const escalatedBy = /^critic override/i.test(reason || '') ? 'critic (rule-based safety override)' : 'action agent';
  const lines = [
    title,
    `Escalated by: ${escalatedBy}`,
    `Open the staff queue: ${dashboardUrl}`
  ];
  return { title, text: lines.join('\n') };
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))
  ]);
}

// Slack reads `text`; Discord reads `content`.
function webhookBody(url, text) {
  return /discord(app)?\.com/i.test(url) ? { content: text } : { text };
}

// Sends to every configured channel. Never throws: a failed alert is logged
// and reported back, but must not break the student's chat response.
async function sendEscalationAlert(ticket, reason, { env = process.env, fetchImpl = fetch, mailer = null } = {}) {
  const channels = alertChannels(env);
  if (!channels.length) return { sent: [], failed: [], skipped: 'no alert channel configured' };

  const dashboardUrl = env.STAFF_DASHBOARD_URL || 'https://occ-chatbot-36q6.vercel.app/#/staff';
  const { title, text } = formatAlert(ticket, reason, dashboardUrl);
  const sent = [];
  const failed = [];

  await Promise.all(channels.map(async channel => {
    try {
      if (channel === 'webhook') {
        const res = await withTimeout(fetchImpl(env.STAFF_ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(webhookBody(env.STAFF_ALERT_WEBHOOK_URL, text))
        }), ALERT_TIMEOUT_MS);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } else {
        const transport = mailer || require('nodemailer').createTransport(env.SMTP_URL);
        await withTimeout(transport.sendMail({
          from: env.STAFF_ALERT_FROM || 'OCC Assistant <no-reply@occ-assistant.local>',
          to: env.STAFF_ALERT_EMAIL,
          subject: title,
          text
        }), ALERT_TIMEOUT_MS);
      }
      sent.push(channel);
    } catch (error) {
      console.error(`Staff alert via ${channel} failed:`, error.message);
      failed.push(channel);
    }
  }));

  return { sent, failed };
}

module.exports = { alertChannels, formatAlert, sendEscalationAlert };
