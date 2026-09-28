// Stage 4: Critic. Deliberately rule-based, not another LLM call — a safety
// net that depends on a second probabilistic model is a weaker safety net.
//
// Everything in this file is pure: it decides, the caller (pipeline/index.js)
// acts. That keeps every rule unit-testable without Groq or a database.

const { detectCrisis, resourceNote } = require('./crisis');

// Any answer that talks about what the law allows gets the disclaimer — the
// model's summary of tenancy law can be wrong in ways a student can't spot.
const LEGAL_ADVICE_PHRASES = [
  'you should sue', 'file a lawsuit', 'lawsuit', 'small claims', 'illegal',
  'legal right', 'legally', 'in violation of the law', 'residential tenancies act',
  'tenant board', 'landlord-tenant board', 'ltb', 'take legal action', 'breach of contract',
  'eviction', 'evict you', 'court order'
];

const UNCITED_NOTE = `\n\n_I couldn't tie this answer to a specific official source — please check the related official pages below before relying on it._`;

const LEGAL_DISCLAIMER =`\n\n_Note: This is general information, not legal advice. For landlord-tenant disputes, contact Waterloo Region Community Legal Services or the Landlord and Tenant Board directly._`;

// Whole-word matching, so "ltb" doesn't fire inside another word. The
// phrases are plain words, spaces, and hyphens, so they need no escaping.
const LEGAL_PATTERNS = LEGAL_ADVICE_PHRASES.map(phrase => [phrase, new RegExp(`\\b${phrase}\\b`)]);

function findPolicySensitivePhrase(text) {
  const lower = (text || '').toLowerCase();
  return LEGAL_PATTERNS.find(([, pattern]) => pattern.test(lower))?.[0] || null;
}
// Kept for callers that only need a yes/no on the student's own words.
const findSafetySignal = text => detectCrisis(text)?.match || null;

// Pre-check, run right after the router. A deterministic backstop: if the
// student's own words describe a crisis, the intent becomes urgent no matter
// what the router said — or whether the router ran at all (model outage).
// Housing emergencies (locked out, nowhere to sleep) keep a normal intent so
// the student still gets an answer about their rights; the post-check adds
// resources and makes sure a person hears about it.
function preCheck(message, routerIntent) {
  const crisis = detectCrisis(message);
  if (crisis?.urgent && routerIntent !== 'urgent') {
    return {
      intent: 'urgent',
      crisis,
      override: `router classified as "${routerIntent || 'unknown'}", but message matched ${crisis.label} ("${crisis.match}") — critic overrode to urgent`
    };
  }
  if (crisis && !crisis.urgent && !routerIntent) {
    return {
      intent: 'housing',
      crisis,
      override: `router failed, but message matched ${crisis.label} ("${crisis.match}") — critic routed to housing`
    };
  }
  return { intent: routerIntent, crisis, override: null };
}

// Post-check, run after the answer and the action agent's side effects are
// assembled but before anything is sent. Returns the (possibly annotated)
// response plus side effects the caller must carry out:
//   escalate:     ticket ids the action agent created at high/urgent but left unescalated
//   ensureTicket: { priority } when this message must reach a person and no ticket
//                 was created this turn — the caller reuses the session's open ticket
//                 if there is one, otherwise opens one, and escalates it
function postCheck({ intent, routerConfidence, matchType, botResponse, actionsTaken, preCheckOverride, citations = [], crisis = null }) {
  const flags = {
    safetyOverride: !!preCheckOverride,
    lowConfidence: false,
    policySensitive: false,
    escalationOverride: false,
    uncited: false,
    crisisResources: false
  };
  const reasons = [];
  if (preCheckOverride) reasons.push(preCheckOverride);

  let response = botResponse;

  if (matchType === 'fallback' || (routerConfidence !== null && routerConfidence !== undefined && routerConfidence < 0.5)) {
    flags.lowConfidence = true;
    reasons.push(`no confident knowledge-base backing (matchType=${matchType}, routerConfidence=${routerConfidence})`);
  }

  // Groundedness: when official passages were retrieved, the answer should
  // cite at least one. If it cites none, the model answered from its own
  // knowledge while the sources sat unused — say so rather than let it read
  // as sourced. This applies even when an FAQ also matched: FAQs carry no
  // legal specifics, so a notice period or percentage came from somewhere.
  if (citations.length > 0 && !citations.some(c => c.cited)) {
    flags.uncited = true;
    reasons.push(`answer cited none of the ${citations.length} official passages it was given`);
    response += UNCITED_NOTE;
  }

  const legalPhrase = findPolicySensitivePhrase(response);
  if (legalPhrase) {
    flags.policySensitive = true;
    reasons.push(`response contains legal-advice-like phrasing ("${legalPhrase}")`);
    response += LEGAL_DISCLAIMER;
  }

  const housingEmergency = crisis && !crisis.urgent && intent !== 'urgent';
  if (housingEmergency) {
    flags.crisisResources = true;
    reasons.push(`message matched ${crisis.label} ("${crisis.match}") — resources added and a person notified`);
    response += resourceNote(crisis.id);
  }

  const created = actionsTaken.filter(a => a.tool === 'create_ticket' && a.result?.ticketId);
  const escalatedIds = new Set(actionsTaken.filter(a => a.tool === 'escalate_ticket' && !a.result?.error).map(a => a.args?.ticketId));

  const escalate = [];
  for (const action of created) {
    const ticketId = action.result.ticketId;
    const priority = action.result.priority || action.args?.priority;
    if (['high', 'urgent'].includes(priority) && !escalatedIds.has(ticketId) && !escalate.includes(ticketId)) {
      escalate.push(ticketId);
      reasons.push(`ticket ${ticketId} was priority=${priority} but wasn't escalated — critic forced it`);
    }
  }

  let ensureTicket = null;
  if (created.length === 0 && (intent === 'urgent' || housingEmergency)) {
    ensureTicket = { priority: intent === 'urgent' ? 'urgent' : 'high' };
    reasons.push(`${intent === 'urgent' ? 'urgent message' : crisis.label} with no ticket from the action agent — critic opened or reused one and escalated it`);
  }

  if (escalate.length || ensureTicket) flags.escalationOverride = true;

  return {
    response,
    flags,
    escalate,
    ensureTicket,
    reasoning: reasons.length ? reasons.join('; ') : 'no critic flags raised'
  };
}

module.exports = {
  LEGAL_ADVICE_PHRASES,
  findSafetySignal,
  findPolicySensitivePhrase,
  preCheck,
  postCheck
};
