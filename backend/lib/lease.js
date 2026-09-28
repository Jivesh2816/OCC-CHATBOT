// Lease Checker. Flags lease clauses that official Ontario / UW guidance says
// are void, prohibited, or worth a second look.
//
// Two detectors, one rule catalog:
//   1. Deterministic regexes per rule — consistent, explainable, always on.
//   2. An LLM pass that reads the numbered clauses and names which catalog
//      rule (if any) each one triggers. It cannot invent rules or quotes: it
//      only returns clause numbers + rule ids, both validated here, so every
//      flag still points at real lease text and a rule we wrote.
//
// Every rule cites passages in sources/official.json (verbatim official
// text), so the explanation a student sees is backed by a link, not by the
// model's memory of tenancy law.

const { citeSources } = require('./cite');

const RULES = [
  {
    id: 'no_pets',
    title: 'Bans pets',
    severity: 'void',
    covers: 'clauses that prohibit or ban the tenant from keeping pets',
    explanation: "Ontario's standard-lease guide lists terms that \"do not allow pets\" as void and unenforceable. One exception: a landlord can require you to follow condominium rules, which may prohibit certain pets.",
    sourceIds: ['guide-ontarios-standard-lease-17', 'renting-ontario-your-rights-11'],
    patterns: [
      /\bno pets?\b/i,
      /\bpets?\b[^.]{0,40}\b(not (be )?(allowed|permitted)|prohibited|forbidden|banned)\b/i,
      /\bnot (allowed|permitted) to (have|keep)\b[^.]{0,25}\b(pets?|animals?)\b/i
    ]
  },
  {
    id: 'no_guests',
    title: 'Restricts guests or occupants',
    severity: 'void',
    covers: 'clauses that ban or restrict guests, visitors, overnight guests, roommates, or additional occupants',
    explanation: 'Terms that "do not allow guests, roommates, any additional occupants" are listed as void in the official guide to the standard lease. Landlords can\'t ban guests.',
    sourceIds: ['guide-ontarios-standard-lease-17', 'renting-ontario-your-rights-11'],
    patterns: [
      /\bno (overnight )?(guests|visitors)\b/i,
      /\b(overnight )?(guests?|visitors?|additional occupants?)\b[^.]{0,40}\b(not (be )?(allowed|permitted)|prohibited|forbidden|banned)\b/i,
      /\bguests? (may|can|shall) not (stay|remain|sleep)\b/i,
      /\bno (additional )?(occupants|roommates)\b/i
    ]
  },
  {
    id: 'prohibited_fees',
    title: 'Charges a deposit or fee the Act doesn\'t allow',
    severity: 'void',
    covers: 'damage deposits, pet deposits, cleaning fees, application fees, holding fees, or non-refundable key deposits',
    explanation: 'Damage and pet deposits are listed as void in the standard-lease guide, and UW Off-Campus Housing notes landlords cannot impose cleaning, application, or holding fees. A key deposit is allowed only if it\'s refundable and no more than the cost of replacing the keys.',
    sourceIds: ['guide-ontarios-standard-lease-18', 'before-you-rent-20', 'know-your-rights-2'],
    patterns: [
      /\b(damage|pet|cleaning)\s+(deposit|fee)s?\b/i,
      /\b(application|holding|cleaning)\s+fees?\b/i,
      /\bnon-?refundable\b[^.]{0,40}\bkey\b|\bkey deposit\b[^.]{0,40}\bnon-?refundable\b/i
    ]
  },
  {
    id: 'late_penalty',
    title: 'Adds a penalty or interest for late rent',
    severity: 'void',
    covers: 'late fees, late-payment penalties, or interest charged on overdue rent / rent arrears',
    explanation: 'The standard-lease guide lists terms requiring "deposits, fees or penalties that are not permitted under the act (e.g., ... interest on rent arrears)" as void.',
    sourceIds: ['guide-ontarios-standard-lease-18'],
    patterns: [
      /\blate (payment )?(fee|charge|penalt)/i,
      /\bpenalt(y|ies)\b[^.]{0,60}\b(late|overdue|rent)\b/i,
      /\binterest\b[^.]{0,40}\b(arrears|late|overdue|unpaid rent)\b/i
    ]
  },
  {
    id: 'tenant_repairs',
    title: 'Makes you pay for the landlord\'s repairs',
    severity: 'void',
    covers: 'clauses making the tenant responsible for all or general repairs/maintenance (not just damage the tenant caused)',
    explanation: 'The landlord must maintain the unit; you only pay for undue damage you or your guests cause. Terms that "require the tenant to pay for all or part of the repairs that are the responsibility of the landlord" are void.',
    sourceIds: ['guide-ontarios-standard-lease-18', 'guide-ontarios-standard-lease-15'],
    patterns: [
      /\btenants?\b[^.]{0,80}\b(responsible for|pay for|shall pay|will pay|must pay|cover)\b[^.]{0,40}\b(all|any)\b[^.]{0,30}\b(repairs?|maintenance)\b/i,
      /\ball (repairs|maintenance)\b[^.]{0,60}\b(tenant'?s?'? (responsibility|expense|cost))\b/i
    ],
    // Paying for damage you caused is lawful — don't flag those clauses.
    exclude: /\b(caused by|damage (caused|done) by|negligen|wilful|willful|misuse)\b/i
  },
  {
    id: 'entry_without_notice',
    title: 'Lets the landlord enter without notice',
    severity: 'void',
    covers: 'clauses letting the landlord enter the unit at any time or without 24 hours\' written notice, outside of emergencies or tenant consent',
    explanation: 'Outside an emergency or your consent at the time, a landlord must give 24 hours\' notice to enter, and only for reasons the Residential Tenancies Act allows (provision 26).',
    sourceIds: ['know-your-rights-5'],
    patterns: [
      /\b(enter|entry|access|inspect|inspection)\b[^.]{0,100}\b(at any time|any time|without (any |prior |advance |written )?notice|without notifying)\b/i
    ],
    exclude: /\bemergenc/i
  },
  {
    id: 'no_sublet',
    title: 'Bans subletting or assignment',
    severity: 'void',
    covers: 'clauses that flatly prohibit subletting or assigning the lease',
    explanation: 'You need the landlord\'s permission to sublet or assign, but the landlord "cannot arbitrarily or unreasonably withhold consent", and that section of the standard lease cannot be changed.',
    sourceIds: ['guide-ontarios-standard-lease-16', 'signing-lease-14'],
    patterns: [
      /\b(no|not|never)\b[^.]{0,40}\b(sublet\w*|sub-let\w*|assign\w*)\b/i,
      /\b(sublet\w*|sub-let\w*|assignment)\b[^.]{0,40}\b(not (be )?(permitted|allowed)|prohibited|forbidden)\b/i
    ],
    // "not ... without the landlord's consent" is the lawful standard-lease wording.
    exclude: /\b(consent|permission|approval)\b/i
  },
  {
    id: 'deposit_limit',
    title: 'Takes a deposit — check the amount',
    severity: 'check',
    covers: 'security, rent, or last-month deposits (lawful only up to one month\'s rent, and only as last month\'s rent)',
    explanation: 'A landlord can ask for last month\'s rent as a deposit, but it\'s illegal to ask for more than one month\'s rent, and it can\'t be used as a damage deposit. You\'re also owed interest on it every 12 months.',
    sourceIds: ['before-you-rent-20', 'know-your-rights-2', 'guide-ontarios-standard-lease-10'],
    patterns: [
      /\b(security|rent|last month'?s?( rent)?)\s+deposit\b/i,
      /\bdeposit of\b/i
    ]
  },
  {
    id: 'shared_with_owner',
    title: 'You may share a kitchen or bathroom with the owner',
    severity: 'check',
    covers: 'arrangements where the tenant shares a kitchen or bathroom with the landlord/owner or their family',
    explanation: 'The Residential Tenancies Act does not apply when you share a kitchen or bathroom with your landlord or their immediate family, so most of the protections above wouldn\'t apply either.',
    sourceIds: ['before-you-rent-3'],
    patterns: [
      /\bshar(e|es|ed|ing)\b[^.]{0,60}\b(kitchen|bathroom|washroom)\b[^.]{0,60}\b(owner|landlord)\b/i,
      /\b(owner|landlord)\b[^.]{0,40}\b(lives|resides|occupies)\b[^.]{0,30}\b(in|at|on)\b[^.]{0,30}\b(unit|premises|property|house|home)\b/i
    ]
  },
  {
    id: 'rent_control_exempt',
    title: 'Says the unit is exempt from rent control',
    severity: 'check',
    covers: 'terms stating the unit is exempt from rent control or the annual rent increase guideline',
    explanation: 'New buildings, additions, and most new basement apartments first occupied after November 15, 2018 are exempt from the rent increase guideline, so rent could rise by more than the yearly cap. Landlords can show this with a section 15 term; you can ask the Landlord and Tenant Board whether a unit is really exempt.',
    sourceIds: ['residential-rent-increases-4', 'residential-rent-increases-11'],
    patterns: [
      /\bexempt\w*\b[^.]{0,60}\brent (control|increase guideline)\b/i,
      /\brent (control|increase guideline)\b[^.]{0,60}\b(not apply|does not apply|exempt)\b/i
    ]
  }
];

const RULES_BY_ID = Object.fromEntries(RULES.map(r => [r.id, r]));
const SEVERITY_ORDER = { void: 0, check: 1 };

const MODEL_CHAR_BUDGET = 14000; // keeps one call inside Groq's free-tier token limits
const MAX_CLAUSE_CHARS = 600;

// Split lease text into clause-sized units: numbered items, lines, sentences.
function splitClauses(text) {
  const normalized = (text || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const clauses = [];
  for (const block of normalized.split(/\n+/)) {
    const sentences = block.split(/(?<=[.;])\s+(?=[A-Z0-9(•-])/);
    for (let sentence of sentences) {
      sentence = sentence.trim();
      if (sentence.length < 12) continue;
      while (sentence.length > MAX_CLAUSE_CHARS) {
        clauses.push(sentence.slice(0, MAX_CLAUSE_CHARS));
        sentence = sentence.slice(MAX_CLAUSE_CHARS);
      }
      if (sentence.length >= 12) clauses.push(sentence);
    }
  }
  return clauses;
}

function ruleMatches(rule, clause) {
  if (rule.exclude && rule.exclude.test(clause)) return false;
  return rule.patterns.some(p => p.test(clause));
}

function detectWithRules(clauses) {
  const hits = [];
  clauses.forEach((clause, index) => {
    for (const rule of RULES) {
      if (ruleMatches(rule, clause)) hits.push({ clauseIndex: index, ruleId: rule.id });
    }
  });
  return hits;
}

function buildModelPrompt(clauses) {
  const catalog = RULES.map(r => `- ${r.id}: ${r.covers}`).join('\n');
  const numbered = [];
  let used = 0;
  for (let i = 0; i < clauses.length; i++) {
    const line = `[${i}] ${clauses[i]}`;
    if (used + line.length > MODEL_CHAR_BUDGET) break;
    numbered.push(line);
    used += line.length + 1;
  }
  return {
    coveredClauses: numbered.length,
    system: `You review Ontario residential leases for a student support tool. You may ONLY use these rule ids:\n${catalog}\n\nFor each numbered clause that clearly triggers one of these rules, output its clause number and rule id. A clause that merely mentions a topic lawfully (e.g. the tenant pays for damage they caused, landlord enters with 24 hours notice, a refundable key deposit) does NOT trigger a rule. Respond with ONLY strict JSON: {"findings": [{"clause": <number>, "rule": "<rule id>"}]}. Use an empty list if nothing applies.`,
    user: numbered.join('\n')
  };
}

// `complete` is injected (server.js passes a Groq call) so this module stays
// testable without network access. Returns validated hits only.
async function detectWithModel(clauses, complete) {
  const prompt = buildModelPrompt(clauses);
  if (!prompt.coveredClauses) return { hits: [], coveredClauses: 0 };

  const raw = await complete(prompt.system, prompt.user);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { hits: [], coveredClauses: prompt.coveredClauses, error: 'model returned invalid JSON' };
  }

  const hits = (Array.isArray(parsed?.findings) ? parsed.findings : [])
    .filter(f => Number.isInteger(f.clause) && f.clause >= 0 && f.clause < prompt.coveredClauses && RULES_BY_ID[f.rule])
    .map(f => ({ clauseIndex: f.clause, ruleId: f.rule }));

  return { hits, coveredClauses: prompt.coveredClauses };
}

function mergeFindings(clauses, ruleHits, modelHits, sourcesById) {
  const byKey = new Map();
  const add = (hit, detector) => {
    const key = `${hit.clauseIndex}:${hit.ruleId}`;
    if (!byKey.has(key)) byKey.set(key, { ...hit, detectedBy: [] });
    const entry = byKey.get(key);
    if (!entry.detectedBy.includes(detector)) entry.detectedBy.push(detector);
  };
  ruleHits.forEach(h => add(h, 'rules'));
  modelHits.forEach(h => add(h, 'model'));

  // A deposit clause already flagged as a prohibited fee doesn't also need
  // the softer "check the amount" note.
  const prohibitedClauses = new Set([...byKey.values()].filter(f => f.ruleId === 'prohibited_fees').map(f => f.clauseIndex));

  return [...byKey.values()]
    .filter(f => !(f.ruleId === 'deposit_limit' && prohibitedClauses.has(f.clauseIndex)))
    .map(f => {
      const rule = RULES_BY_ID[f.ruleId];
      return {
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        explanation: rule.explanation,
        clauseNumber: f.clauseIndex + 1,
        quote: clauses[f.clauseIndex],
        detectedBy: f.detectedBy,
        sources: citeSources(rule.sourceIds, sourcesById)
      };
    })
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.clauseNumber - b.clauseNumber);
}

async function analyzeLease(text, { complete, sourcesById }) {
  const clauses = splitClauses(text);
  const ruleHits = detectWithRules(clauses);

  let model = { hits: [], coveredClauses: 0, error: null };
  if (complete) {
    try {
      model = await detectWithModel(clauses, complete);
    } catch (error) {
      model = { hits: [], coveredClauses: 0, error: error?.message || 'model call failed' };
    }
  }

  const findings = mergeFindings(clauses, ruleHits, model.hits, sourcesById);
  return {
    findings,
    summary: {
      clauses: clauses.length,
      void: findings.filter(f => f.severity === 'void').length,
      check: findings.filter(f => f.severity === 'check').length,
      modelReviewedClauses: model.coveredClauses,
      modelError: model.error || null
    }
  };
}

module.exports = { RULES, splitClauses, detectWithRules, analyzeLease };
