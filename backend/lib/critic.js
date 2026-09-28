// Stage 4: Critic. Deliberately rule-based, not another LLM call — a safety
// net that depends on a second probabilistic model is a weaker safety net.
//
// Everything in this file is pure: it decides, the caller (server.js) acts.
// That keeps every rule unit-testable without Groq or a database.

const SAFETY_SIGNAL_PHRASES = [
  'kill myself', 'want to die', 'end my life', 'suicidal', 'suicide',
  'hurt myself', 'self-harm', 'self harm',
  'being abused', 'domestic violence', 'assaulted', 'sexually assaulted',
  'hit me', 'hitting me', 'punched me', 'attacked me', 'threatened to kill',
  'someone is trying to hurt me', 'i am in danger', "i'm in danger",
  'not safe right now', 'unsafe right now', "don't feel safe", 'do not feel safe',
  'stalking me'
];

const LEGAL_ADVICE_PHRASES = [
  'you should sue', 'file a lawsuit', 'small claims court', 'this is illegal',
  'you have a legal right to', 'legally required to', 'in violation of the law',
  'landlord and tenant board', 'ltb hearing', 'take legal action', 'breach of contract'
];

const LEGAL_DISCLAIMER = `\n\n_Note: This is general information, not legal advice. For landlord-tenant disputes, contact Waterloo Region Community Legal Services or the Landlord and Tenant Board directly._`;

function findPhrase(text, phrases) {
  const lower = (text || '').toLowerCase();
  return phrases.find(phrase => lower.includes(phrase)) || null;
}

const findSafetySignal = text => findPhrase(text, SAFETY_SIGNAL_PHRASES);
const findPolicySensitivePhrase = text => findPhrase(text, LEGAL_ADVICE_PHRASES);

// Pre-check, run right after the router. A deterministic backstop: if the
// student's own words match a safety phrase, the intent becomes urgent no
// matter what the router's LLM judgment was.
function preCheck(message, routerIntent) {
  const safetySignal = findSafetySignal(message);
  if (safetySignal && routerIntent !== 'urgent') {
    return {
      intent: 'urgent',
      override: `router classified as "${routerIntent || 'unknown'}", but message matched safety-signal phrase "${safetySignal}" — critic overrode to urgent`
    };
  }
  return { intent: routerIntent, override: null };
}

// Post-check, run after the answer and the action agent's side effects are
// assembled but before anything is sent. Returns the (possibly annotated)
// response plus a list of side effects the caller must carry out:
//   escalate:     ticket ids the action agent created at high/urgent but left unescalated
//   createUrgent: true when the message is urgent and no ticket exists at all —
//                 a crisis must always reach a human, even if the model declined to act
function postCheck({ intent, routerConfidence, matchType, botResponse, actionsTaken, preCheckOverride }) {
  const flags = {
    safetyOverride: !!preCheckOverride,
    lowConfidence: false,
    policySensitive: false,
    escalationOverride: false
  };
  const reasons = [];
  if (preCheckOverride) reasons.push(preCheckOverride);

  let response = botResponse;

  if (matchType === 'fallback' || (routerConfidence !== null && routerConfidence !== undefined && routerConfidence < 0.5)) {
    flags.lowConfidence = true;
    reasons.push(`no confident knowledge-base backing (matchType=${matchType}, routerConfidence=${routerConfidence})`);
  }

  const legalPhrase = findPolicySensitivePhrase(response);
  if (legalPhrase) {
    flags.policySensitive = true;
    reasons.push(`response contains legal-advice-like phrasing ("${legalPhrase}")`);
    response += LEGAL_DISCLAIMER;
  }

  const created = actionsTaken.filter(a => a.tool === 'create_ticket' && a.result?.ticketId);
  const escalatedIds = new Set(actionsTaken.filter(a => a.tool === 'escalate_ticket' && !a.result?.error).map(a => a.args?.ticketId));

  const escalate = [];
  for (const action of created) {
    const ticketId = action.result.ticketId;
    if (['high', 'urgent'].includes(action.args?.priority) && !escalatedIds.has(ticketId)) {
      escalate.push(ticketId);
      reasons.push(`ticket ${ticketId} was priority=${action.args.priority} but wasn't escalated — critic forced it`);
    }
  }

  const createUrgent = intent === 'urgent' && created.length === 0;
  if (createUrgent) reasons.push('urgent message with no ticket from the action agent — critic opened and escalated one');

  if (escalate.length || createUrgent) flags.escalationOverride = true;

  return {
    response,
    flags,
    escalate,
    createUrgent,
    reasoning: reasons.length ? reasons.join('; ') : 'no critic flags raised'
  };
}

module.exports = {
  SAFETY_SIGNAL_PHRASES,
  LEGAL_ADVICE_PHRASES,
  findSafetySignal,
  findPolicySensitivePhrase,
  preCheck,
  postCheck
};
