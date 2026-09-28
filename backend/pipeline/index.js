const crypto = require('crypto');
const { db } = require('../db');
const critic = require('../lib/critic');
const { alertChannels } = require('../lib/alerts');
const { getIntelligentResponse } = require('../lib/knowledge');
const { now, recentMessages, createTicketRecord, escalateTicketRecord } = require('../lib/tickets');
const { HISTORY_TURNS } = require('./memory');
const { classifyIntent } = require('./router');
const { generateAnswer, retrievalAgent } = require('./retrieval');
const { ACTION_AGENT_INTENTS, actionAgent } = require('./action');

const URGENT_RESOURCES = `⚠️ This sounds like it may need more urgent, real-world help than a chatbot can give.

Please reach out directly:
• **Emergency**: 911
• **Campus Police**: 519-888-4911
• **Waterloo Regional Police (non-emergency)**: 519-570-9777
• **Good2Talk (student mental health line)**: 1-866-925-5454`;

// Only promise a person when staff actually get notified — a queue nobody is
// alerted to isn't a handoff, and a student in crisis shouldn't be told one is
// coming when it may not be.
const URGENT_ESCALATION_MESSAGE = alertChannels().length
  ? `${URGENT_RESOURCES}\n\nThis conversation has also been sent to the Off-Campus support team, and any reply will show up right here — but please don't wait on that if you're in danger. Use the numbers above.`
  : `${URGENT_RESOURCES}\n\nPlease use the numbers above — they're staffed by people who can help right now.`;

// ---------------------------------------------------------------------------
// Stage 4: Critic side effects. The rules live in lib/critic.js (pure); this
// carries out what they decide and logs every decision, fired or not.
// ---------------------------------------------------------------------------

async function applyCritic({ message, intent, routerConfidence, matchType, botResponse, actionsTaken, preCheckOverride, citations, sessionId }) {
  const decision = critic.postCheck({ intent, routerConfidence, matchType, botResponse, actionsTaken, preCheckOverride, citations });
  const actions = [...actionsTaken];

  for (const ticketId of decision.escalate) {
    const reason = 'Critic override: high/urgent priority ticket was not escalated by the action agent.';
    const result = await escalateTicketRecord({ ticketId, reason });
    actions.push({ tool: 'escalate_ticket', args: { ticketId, reason }, result, forcedByCritic: true });
  }

  if (decision.createUrgent) {
    const args = { category: 'crisis', summary: 'Urgent/safety message — opened by the critic because no ticket existed.', priority: 'urgent' };
    const created = await createTicketRecord(args, message, intent, sessionId);
    actions.push({ tool: 'create_ticket', args, result: created, forcedByCritic: true });
    const reason = 'Critic override: urgent message must reach a human.';
    const escalated = await escalateTicketRecord({ ticketId: created.ticketId, reason });
    actions.push({ tool: 'escalate_ticket', args: { ticketId: created.ticketId, reason }, result: escalated, forcedByCritic: true });
  }

  await db.run(
    `INSERT INTO critic_log (session_id, timestamp, message, intent, router_confidence, match_type, flags_json, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, now(), message, intent, routerConfidence, matchType, JSON.stringify(decision.flags), decision.reasoning]
  );

  return { response: decision.response, actionsTaken: actions, flags: decision.flags, reasoning: decision.reasoning };
}

// ---------------------------------------------------------------------------
// The pipeline. `emit` receives trace events as each stage runs; /chat/stream
// forwards them to the browser, /chat ignores them and returns the final
// payload. Same code path either way, so the eval exercises what users get.
// ---------------------------------------------------------------------------

async function runPipeline({ message, sessionId: incomingSessionId, emit = () => {} }) {
  // A session id ties messages/tickets/critic decisions together. The client
  // sends back whatever id we gave it last time; if it sends none (first
  // message, or storage was cleared), a new one is minted and returned.
  const sessionId = incomingSessionId || crypto.randomUUID();
  const history = await recentMessages(sessionId, HISTORY_TURNS);
  await db.run('INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)', [sessionId, now()]);
  await db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [sessionId, 'user', message, now()]);
  emit({ type: 'session', sessionId, memoryTurns: history.length });

  const trace = [];
  const stage = async (name, fn, describe) => {
    emit({ type: 'step', stage: name, status: 'running' });
    const started = Date.now();
    const result = await fn();
    const step = { stage: name, status: 'done', ms: Date.now() - started, ...describe(result) };
    trace.push(step);
    emit({ type: 'step', ...step });
    return result;
  };

  console.log('Processing question:', message, 'session:', sessionId, 'memory turns:', history.length);

  // Stage 1: route before any retrieval. Null means the router itself
  // failed (Groq error/bad JSON) — treat that like the old ungated flow.
  const routerResult = await stage('router', () => classifyIntent(message, history), r => ({
    intent: r?.intent || null,
    confidence: r?.confidence ?? null,
    usedMemory: history.length > 0,
    incident: r?.incident ?? null
  }));
  const routerConfidence = routerResult?.confidence ?? null;

  // Stage 4a: critic pre-check — a deterministic backstop independent of
  // the router's LLM judgment. If it fires, it wins.
  const pre = await stage('critic_pre', async () => critic.preCheck(message, routerResult?.intent || null), r => ({
    override: r.override
  }));
  const intent = pre.intent;
  const preCheckOverride = pre.override;

  let botResponse, source, metadata, category, matchType, citations = [];
  const onToken = text => emit({ type: 'token', text });

  if (intent === 'urgent') {
    // Urgent-flag intents skip retrieval and generation entirely.
    await stage('retrieval', async () => null, () => ({ skipped: 'urgent — fixed crisis-resources reply' }));
    botResponse = URGENT_ESCALATION_MESSAGE;
    onToken(botResponse);
    source = 'router_escalation';
    matchType = 'escalation';
    category = null;
    metadata = { intent, confidence: routerConfidence };
  } else if (intent === 'out_of_scope') {
    // Out-of-scope intents also skip retrieval; answer with general knowledge only.
    const answer = await stage('retrieval', () => generateAnswer({ message, history, onToken }), () => ({ skipped: 'out of scope — no knowledge-base lookup' }));
    botResponse = answer || getIntelligentResponse(message);
    source = answer ? 'router_out_of_scope' : 'intelligent_response';
    matchType = 'fallback';
    category = null;
    metadata = { intent, confidence: routerConfidence };
    if (!answer) onToken(botResponse);
  } else {
    // In-scope intent (or router failed and intent is null) — hand off to
    // the retrieval agent.
    let retrieved = null;
    const result = await stage(
      'retrieval',
      () => retrievalAgent(message, intent, { history, onToken, onRetrieved: r => { retrieved = r; emit({ type: 'retrieved', ...r }); } }),
      r => ({ faqs: retrieved?.faqs || [], sources: retrieved?.sources || [], matchType: r.matchType, groqFailed: r.metadata?.error === 'groq_failed' })
    );
    botResponse = result.response;
    if (result.metadata?.error === 'groq_failed') onToken(botResponse);
    source = result.source;
    matchType = result.matchType;
    category = result.category;
    citations = result.citations;
    metadata = { ...result.metadata, confidence: routerConfidence };
  }

  // Stage 3: action agent — only runs for intents where a real incident
  // (not just an FAQ lookup) might need a ticket, email, or escalation.
  let actions = [];
  // The router also judges whether the message describes a real incident.
  // General questions skip the action agent entirely, which saves a model
  // call on most housing/health messages under Groq's free-tier token budget.
  // Urgent messages always go through; the critic backs that up regardless.
  const isIncident = intent === 'urgent' || routerResult?.incident !== false;
  const skipReason = !ACTION_AGENT_INTENTS.includes(intent)
    ? `intent "${intent}" never needs a ticket`
    : !isIncident ? 'general question, not an incident — nothing to act on' : null;

  if (!skipReason) {
    const actionResult = await stage('action', () => actionAgent(message, intent, category, sessionId, history), r => ({
      actions: r.actionsTaken.map(a => ({ tool: a.tool, ticketId: a.result?.ticketId || a.args?.ticketId || null, error: a.result?.error || null }))
    }));
    actions = actionResult.actionsTaken;
  } else {
    trace.push({ stage: 'action', status: 'skipped', reason: skipReason });
    emit({ type: 'step', stage: 'action', status: 'skipped', reason: skipReason });
  }

  // Stage 4b: critic review — runs before anything is sent, can annotate the
  // response and force an escalation the action agent didn't make.
  const reviewed = await stage('critic', () => applyCritic({ message, intent, routerConfidence, matchType, botResponse, actionsTaken: actions, preCheckOverride, citations, sessionId }), r => ({
    flags: r.flags,
    reasoning: r.reasoning,
    forced: r.actionsTaken.filter(a => a.forcedByCritic).map(a => a.tool)
  }));
  botResponse = reviewed.response;
  actions = reviewed.actionsTaken;

  await db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [sessionId, 'bot', botResponse, now()]);
  const recent = await recentMessages(sessionId, 10);

  console.log('Sending response:', { source, category, preview: botResponse.substring(0, 100) + '...', criticFlags: reviewed.flags });

  return {
    response: botResponse,
    sessionId,
    history: recent,
    actions,
    criticFlags: reviewed.flags,
    source,
    category,
    matchType,
    intent,
    routerConfidence,
    citations,
    trace,
    memoryTurns: history.length,
    metadata
  };
}

module.exports = { runPipeline };
