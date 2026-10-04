const crypto = require('crypto');
const { db } = require('../db');
const critic = require('../lib/critic');
const { alertChannels } = require('../lib/alerts');
const { urgentReply } = require('../lib/crisis');
const { getIntelligentResponse } = require('../lib/knowledge');
const { now, recentMessages, createTicketRecord, escalateTicketRecord } = require('../lib/tickets');
const { HISTORY_TURNS } = require('./memory');
const { classifyIntent } = require('./router');
const { generateAnswer, retrievalAgent } = require('./retrieval');
const { ACTION_AGENT_INTENTS, actionAgent } = require('./action');

// Only promise a person when staff actually get notified — a queue nobody is
// alerted to isn't a handoff, and a student in crisis shouldn't be told one is
// coming when it may not be.
const staffHandoff = () => alertChannels().length > 0;

// ---------------------------------------------------------------------------
// Stage 4: Critic side effects. The rules live in lib/critic.js (pure); this
// carries out what they decide and logs every decision, fired or not.
// ---------------------------------------------------------------------------

async function applyCritic({ message, intent, routerConfidence, matchType, botResponse, actionsTaken, preCheckOverride, citations, crisis, sessionId }) {
  const decision = critic.postCheck({ intent, routerConfidence, matchType, botResponse, actionsTaken, preCheckOverride, citations, crisis });
  const actions = [...actionsTaken];

  for (const ticketId of decision.escalate) {
    const reason = 'Critic override: high/urgent priority ticket was not escalated by the action agent.';
    const result = await escalateTicketRecord({ ticketId, reason }, sessionId);
    actions.push({ tool: 'escalate_ticket', args: { ticketId, reason }, result, forcedByCritic: true });
  }

  if (decision.ensureTicket) {
    // Reuses the session's open ticket when there is one (createTicketRecord
    // dedupes), so a student repeating themselves raises one alert, not three.
    const label = crisis?.label || 'urgent message';
    const args = { category: crisis?.id || 'crisis', summary: `${label[0].toUpperCase()}${label.slice(1)} — opened by the critic because the action agent opened no ticket.`, priority: decision.ensureTicket.priority };
    const created = await createTicketRecord(args, message, intent, sessionId);
    actions.push({ tool: 'create_ticket', args, result: created, forcedByCritic: true });
    const reason = `Critic override: ${label} must reach a person.`;
    const escalated = await escalateTicketRecord({ ticketId: created.ticketId, reason }, sessionId);
    actions.push({ tool: 'escalate_ticket', args: { ticketId: created.ticketId, reason }, result: escalated, forcedByCritic: true });
  }

  // The student's words are already in `messages` (same session and time), and
  // nothing reads them from here, so the critic log doesn't keep a second copy
  // of what can be crisis text. The column stays, empty, for schema compatibility.
  await db.run(
    `INSERT INTO critic_log (session_id, timestamp, message, intent, router_confidence, match_type, flags_json, reasoning)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [sessionId, now(), '', intent, routerConfidence, matchType, JSON.stringify(decision.flags), decision.reasoning]
  );

  return { response: decision.response, actionsTaken: actions, flags: decision.flags, reasoning: decision.reasoning };
}

// ---------------------------------------------------------------------------
// The pipeline. `emit` receives trace events as each stage runs; /chat/stream
// forwards them to the browser, /chat ignores them and returns the final
// payload. Same code path either way, so the eval exercises what users get.
// ---------------------------------------------------------------------------

// Session ids double as the credential for reading a conversation, so logs
// carry a short one-way hash that still groups a session's requests.
const sessionRef = sessionId => crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 12);

// One structured line per request: enough to diagnose routing, retrieval,
// tool and escalation problems, and none of the student's words.
function requestLog({ requestId, sessionId, message, routerResult, intent, crisis, preCheckOverride, retrieved, citations, actions, flags, matchType, source, metadata, trace, startedAt, escalated, staffAlerted }) {
  return {
    event: 'chat_request',
    requestId,
    session: sessionRef(sessionId),
    at: new Date(startedAt).toISOString(),
    chars: message.length,
    routerIntent: routerResult?.intent ?? null,
    routerConfidence: routerResult?.confidence ?? null,
    incident: routerResult?.incident ?? null,
    intent,
    crisis: crisis?.id || null,
    criticOverride: !!preCheckOverride,
    matchType,
    source,
    retrieved: retrieved ? { faqIds: retrieved.faqIds, sourceIds: retrieved.sources.map(s => s.id), scores: retrieved.scores } : null,
    cited: citations.filter(c => c.cited).map(c => c.id),
    tools: actions.map(a => ({ tool: a.tool, forcedByCritic: !!a.forcedByCritic, ok: !a.result?.error })),
    escalated,
    staffAlerted,
    criticFlags: Object.keys(flags).filter(k => flags[k]),
    modelFallback: metadata?.error === 'groq_failed',
    latencyMs: { total: Date.now() - startedAt, ...Object.fromEntries(trace.filter(s => s.ms !== undefined).map(s => [s.stage, s.ms])) }
  };
}

async function runPipeline({ message, sessionId: incomingSessionId, emit = () => {}, requestId = crypto.randomUUID() }) {
  const startedAt = Date.now();
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

  // Message text stays out of the logs: they're kept by the host on a
  // different schedule from the database, and messages can hold crisis details.
  console.log(JSON.stringify({ event: 'chat_start', requestId, session: sessionRef(sessionId), chars: message.length, memoryTurns: history.length }));

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
    override: r.override,
    crisis: r.crisis?.id || null
  }));
  const intent = pre.intent;
  const preCheckOverride = pre.override;
  const crisis = pre.crisis;

  let botResponse, source, metadata, category, matchType, citations = [];
  let retrieved = null;
  const onToken = text => emit({ type: 'token', text });

  if (intent === 'urgent') {
    // Urgent-flag intents skip retrieval and generation entirely.
    await stage('retrieval', async () => null, () => ({ skipped: 'urgent — fixed crisis-resources reply' }));
    botResponse = urgentReply(crisis?.id, { staffHandoff: staffHandoff() });
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
    const result = await stage(
      'retrieval',
      () => retrievalAgent(message, intent, { history, crisis, onToken, onRetrieved: r => { retrieved = r; emit({ type: 'retrieved', ...r }); } }),
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
  const reviewed = await stage('critic', () => applyCritic({ message, intent, routerConfidence, matchType, botResponse, actionsTaken: actions, preCheckOverride, citations, crisis, sessionId }), r => ({
    flags: r.flags,
    reasoning: r.reasoning,
    forced: r.actionsTaken.filter(a => a.forcedByCritic).map(a => a.tool)
  }));
  botResponse = reviewed.response;
  actions = reviewed.actionsTaken;

  await db.run('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)', [sessionId, 'bot', botResponse, now()]);
  const recent = await recentMessages(sessionId, 10);

  const escalated = actions.some(a => a.tool === 'escalate_ticket' && a.result?.escalated);
  const staffAlerted = actions.some(a => a.tool === 'escalate_ticket' && a.result?.staffAlerted);
  console.log(JSON.stringify(requestLog({
    requestId, sessionId, message, routerResult, intent, crisis, preCheckOverride, retrieved, citations,
    actions, flags: reviewed.flags, matchType, source, metadata, trace, startedAt, escalated, staffAlerted
  })));

  return {
    requestId,
    response: botResponse,
    sessionId,
    history: recent,
    actions,
    criticFlags: reviewed.flags,
    // Whether a person was actually brought in, for the UI's wording.
    escalated,
    staffAlerted,
    staffHandoff: staffHandoff(),
    crisis: crisis?.id || null,
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
