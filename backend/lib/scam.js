// Listing Scam Checker. Scores a pasted rental listing / landlord message
// against warning signs taken from the UW Special Constable Service's rental
// fraud guidance and UW Off-Campus Housing's rent estimates.
//
// Same shape as the Lease Checker: deterministic patterns plus an LLM pass
// that can only name signals from this catalog and must quote text that
// actually appears in the listing. The risk level is computed here from the
// validated signals — the model never sets it directly.

const { citeSources } = require('./cite');

const SIGNALS = [
  {
    id: 'untraceable_payment',
    label: 'Asks for wire transfer, crypto, or gift cards',
    weight: 3,
    covers: 'payment by wire transfer, Western Union, MoneyGram, cryptocurrency/bitcoin, or gift cards',
    sourceIds: ['frauds-and-scams-2'],
    patterns: [/\bwire (transfer|the money|money)\b/i, /\bwestern union\b|\bmoneygram\b/i, /\b(bitcoin|crypto\w*|usdt)\b/i, /\bgift ?cards?\b/i]
  },
  {
    id: 'pay_before_viewing',
    label: 'Wants money before you see the place',
    weight: 3,
    covers: 'requests to send a deposit or rent before an in-person viewing, or statements that the unit cannot be viewed',
    sourceIds: ['frauds-and-scams-1', 'frauds-and-scams-2', 'know-your-rights-7'],
    patterns: [
      /\b(pay|paid|payment|send|deposit|e-?transfer|money|rent)\b[^.]{0,40}\b(before|prior to)\b[^.]{0,30}\b(viewing|showing|seeing|see the)\b/i,
      /\b(can'?t|cannot|unable to|not able to|no)\b[^.]{0,25}\b(show|view|viewing|showings|tour)\b/i,
      /\b(deposit|payment|e-?transfer)\b[^.]{0,40}\b(to (hold|secure|reserve))\b/i,
      /\bkeys?\b[^.]{0,40}\b(mail|mailed|courier|ship|shipped|sent to you)\b/i
    ]
  },
  {
    id: 'overseas_landlord',
    label: 'Landlord is out of the country or away',
    weight: 2,
    covers: 'the landlord saying they live abroad, are out of the country, or are away and cannot meet',
    sourceIds: ['frauds-and-scams-2'],
    patterns: [/\b(out of (the )?country|overseas|abroad|out of town|travell?ing for work|on a mission|missionary)\b/i]
  },
  {
    id: 'overpayment',
    label: 'Overpayment / "send the difference back"',
    weight: 3,
    covers: 'sending more money than owed and asking for the difference to be returned',
    sourceIds: ['frauds-and-scams-2'],
    patterns: [/\boverpa(y|id|yment)\b/i, /\b(send|refund|return|transfer)\b[^.]{0,30}\b(the )?(difference|extra|excess|balance) back\b/i]
  },
  {
    id: 'urgency',
    label: 'Pressure to decide fast',
    weight: 1,
    covers: 'urgency or pressure: first come first served, many people interested, decide today, act fast',
    sourceIds: ['frauds-and-scams-2'],
    patterns: [/\bfirst come,? first serve/i, /\b(act|decide|move) (fast|quickly|now)\b/i, /\b(many|lots of|other) (people|applicants|students) (are )?interested\b/i, /\b(today only|won'?t last|asap|immediately|within 24 hours)\b/i]
  },
  {
    id: 'personal_banking_info',
    label: 'Asks for banking or sensitive personal info up front',
    weight: 2,
    covers: 'requests for banking details, SIN, passport/ID scans, or a questionnaire of personal/banking information before any lease',
    sourceIds: ['frauds-and-scams-1', 'frauds-and-scams-3', 'know-your-rights-6'],
    patterns: [/\b(bank(ing)? (info|information|details|account)|account number|routing number)\b/i, /\b(sin|social insurance number)\b/i, /\b(passport|driver'?s licen[cs]e)\b[^.]{0,30}\b(copy|scan|photo|picture)\b/i, /\bquestionnaire\b/i]
  },
  {
    id: 'illegal_fees',
    label: 'Charges a fee landlords can\'t charge',
    weight: 1,
    covers: 'application fees, holding fees, cleaning fees, or damage deposits',
    sourceIds: ['before-you-rent-20'],
    patterns: [/\b(application|holding|cleaning)\s+fees?\b/i, /\bdamage deposit\b/i]
  },
  {
    id: 'below_market',
    label: 'Price well below UW\'s typical rent estimate',
    weight: 2,
    covers: '(computed from the listed price; not selected by the model)',
    sourceIds: ['before-you-rent-2', 'before-you-rent-3', 'frauds-and-scams-1'],
    patterns: []
  }
];

const SIGNALS_BY_ID = Object.fromEntries(SIGNALS.map(s => [s.id, s]));

// UW Off-Campus Housing's published "estimate cost per month" by rental type
// (sources: before-you-rent-2 / -3). Checked most-specific first.
const RENT_ESTIMATES = [
  { type: 'basement unit', estimate: 1200, pattern: /\bbasement\b/i },
  { type: 'studio', estimate: 1020, pattern: /\b(studio|bachelor)\b/i },
  { type: 'room in a shared home', estimate: 870, pattern: /\b(room|bedroom) (in|for rent in) (a )?(shared|house|home)\b|\bshared (house|home|accommodation)\b|\broom for rent\b/i },
  { type: 'entire house', estimate: 1900, pattern: /\b(entire|whole|detached) (house|home)\b/i },
  { type: 'private apartment', estimate: 2120, pattern: /\b(\d\s?(bed|br|bedroom)|apartment|condo)\b/i }
];
const BELOW_MARKET_RATIO = 0.6;

function findPrice(text) {
  const match = text.match(/\$\s?(\d{1,2},?\d{3}|\d{3})(?:\.\d{2})?\b(?:\s*(?:\/|per|a)\s*(?:month|mo)\b)?/i);
  return match ? Number(match[1].replace(',', '')) : null;
}

function checkPrice(text) {
  const price = findPrice(text);
  if (!price) return null;
  const estimate = RENT_ESTIMATES.find(e => e.pattern.test(text));
  if (!estimate) return { price, estimate: null };
  return { price, ...estimate, belowMarket: price < estimate.estimate * BELOW_MARKET_RATIO };
}

function snippetAround(text, index, length) {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1);
  const endDot = text.indexOf('.', index + length);
  const end = endDot === -1 ? Math.min(text.length, index + length + 120) : endDot + 1;
  return text.slice(start, end).trim().slice(0, 300);
}

function detectWithRules(text) {
  const hits = [];
  for (const signal of SIGNALS) {
    for (const pattern of signal.patterns) {
      const m = pattern.exec(text);
      if (m) {
        hits.push({ signalId: signal.id, quote: snippetAround(text, m.index, m[0].length) });
        break;
      }
    }
  }
  return hits;
}

const normalize = s => s.toLowerCase().replace(/\s+/g, ' ').trim();

async function detectWithModel(text, complete) {
  const catalog = SIGNALS.filter(s => s.patterns.length).map(s => `- ${s.id}: ${s.covers}`).join('\n');
  const system = `You check rental listings and landlord messages for scam warning signs, for university students. You may ONLY use these signal ids:\n${catalog}\n\nFor each signal clearly present, give the signal id and a short EXACT quote copied from the listing that shows it. Do not flag a signal just because it is absent or merely possible. Respond with ONLY strict JSON: {"signals": [{"id": "<signal id>", "quote": "<exact text from the listing>"}]}.`;
  const raw = await complete(system, text.slice(0, 8000));

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { hits: [], error: 'model returned invalid JSON' };
  }

  const haystack = normalize(text);
  const hits = (Array.isArray(parsed?.signals) ? parsed.signals : [])
    // Only keep quotes that really occur in the listing — no paraphrased or invented evidence.
    .filter(s => SIGNALS_BY_ID[s.id] && SIGNALS_BY_ID[s.id].patterns.length && typeof s.quote === 'string' && s.quote.trim().length >= 4 && haystack.includes(normalize(s.quote)))
    .map(s => ({ signalId: s.id, quote: s.quote.trim().slice(0, 300) }));
  return { hits };
}

function riskLevel(signals) {
  const score = signals.reduce((sum, s) => sum + s.weight, 0);
  if (signals.some(s => s.weight >= 3) || score >= 4) return { level: 'high', score };
  if (score >= 2) return { level: 'medium', score };
  return { level: 'low', score };
}

async function analyzeListing(text, { complete, sourcesById }) {
  const ruleHits = detectWithRules(text);
  let model = { hits: [], error: null };
  if (complete) {
    try {
      model = await detectWithModel(text, complete);
    } catch (error) {
      model = { hits: [], error: error?.message || 'model call failed' };
    }
  }

  const price = checkPrice(text);
  const byId = new Map();
  const add = (hit, detector) => {
    if (!byId.has(hit.signalId)) byId.set(hit.signalId, { signalId: hit.signalId, quote: hit.quote, detectedBy: [] });
    const entry = byId.get(hit.signalId);
    if (!entry.detectedBy.includes(detector)) entry.detectedBy.push(detector);
  };
  ruleHits.forEach(h => add(h, 'rules'));
  model.hits.forEach(h => add(h, 'model'));
  if (price?.belowMarket) {
    add({
      signalId: 'below_market',
      quote: `Listed at $${price.price}/month for a ${price.type}; UW Off-Campus Housing's estimate is about $${price.estimate}/month.`
    }, 'rules');
  }

  const signals = [...byId.values()].map(entry => {
    const signal = SIGNALS_BY_ID[entry.signalId];
    return {
      id: signal.id,
      label: signal.label,
      weight: signal.weight,
      quote: entry.quote,
      detectedBy: entry.detectedBy,
      sources: citeSources(signal.sourceIds, sourcesById)
    };
  }).sort((a, b) => b.weight - a.weight);

  return {
    risk: riskLevel(signals),
    signals,
    price,
    modelError: model.error || null,
    nextSteps: [
      'Go to the address and view the unit in person before sending any money.',
      'Never send money by wire transfer or out of the country, and never return an "overpayment".',
      'Limit the personal and banking information you share until you have a signed lease.',
      'If you\'ve already paid: gather your records, report it to UW Special Constable Service and the Canadian Anti-Fraud Centre, and tell your bank and the site the ad was on.'
    ],
    nextStepsSource: { title: 'Frauds and Scams', publisher: 'UW Special Constable Service', url: 'https://uwaterloo.ca/special-constable-service/campus-safety/frauds-and-scams' }
  };
}

module.exports = { SIGNALS, detectWithRules, checkPrice, riskLevel, analyzeListing };
