// Heuristic fabrication scan. The answer prompt forbids stating phone numbers,
// emails, web addresses, percentages, fees, or form numbers that aren't in the
// retrieved context. This checks answers for those "specifics" and flags any
// that appear nowhere in the knowledge base (FAQs, official passages, crisis
// resources) or in the student's own message.
//
// It's a heuristic: it can flag a legitimately computed figure (1.9% of $1,500)
// and it can't catch an invented business name. Flags are listed per case for
// a person to review; the aggregate is reported as "unsupported specifics",
// not as a hallucination rate.
const { officialSources, allFAQs, getIntelligentResponse } = require('../../lib/knowledge');
const { RESOURCES, SAFETY_FOOTER } = require('../../lib/crisis');

const digits = s => s.replace(/\D/g, '');

let corpusCache = null;
function corpus() {
  if (corpusCache) return corpusCache;
  const text = [
    ...officialSources.map(s => `${s.url} ${s.heading} ${s.text}`),
    ...allFAQs().map(f => `${f.question} ${f.answer}`),
    ...Object.values(RESOURCES),
    SAFETY_FOOTER,
    // The no-model fallback names a few sites itself, one per topic.
    ...['lease', 'food', 'bus', 'health', 'hello'].map(topic => getIntelligentResponse(topic))
  ].join('\n').toLowerCase();
  corpusCache = { text, digitsText: digits(text) };
  return corpusCache;
}

const PATTERNS = {
  phone: /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g,
  email: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g,
  domain: /\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+(?:ca|com|org|net|gov|edu))\b/gi,
  percent: /\b\d+(?:\.\d+)?\s?%/g,
  dollars: /\$\s?\d[\d,]*(?:\.\d{2})?/g,
  // LTB forms are N1–N13, L1–L10, T1–T7 (+ letter variants).
  form: /\b(?:form\s+)?([NLT]\d{1,2}[A-Z]?)\b(?=[^a-z]|$)/g
};

// A narrower allowed set: only the context the model was actually given, plus
// text the system itself appends (crisis resources, fallback pointers). An
// answer can pass the whole-KB scan while quoting a number from a passage it
// was never shown; this catches that.
function contextCorpus(contextText) {
  const text = [contextText, ...Object.values(RESOURCES), SAFETY_FOOTER].join('\n').toLowerCase();
  return { text, digitsText: digits(text) };
}

function scanAnswer(answer, { userText = '', contextText = null } = {}) {
  const { text, digitsText } = contextText === null ? corpus() : contextCorpus(contextText);
  const user = userText.toLowerCase();
  const inSources = value => text.includes(value.toLowerCase()) || user.includes(value.toLowerCase());
  const unsupported = [];
  const checked = [];
  const body = String(answer || '');

  for (const m of body.matchAll(PATTERNS.phone)) {
    const d = digits(m[0]).slice(-10);
    checked.push({ type: 'phone', value: m[0] });
    if (!digitsText.includes(d) && !digits(user).includes(d)) unsupported.push({ type: 'phone', value: m[0].trim() });
  }
  for (const m of body.matchAll(PATTERNS.email)) {
    checked.push({ type: 'email', value: m[0] });
    if (!inSources(m[0])) unsupported.push({ type: 'email', value: m[0] });
  }
  for (const m of body.matchAll(PATTERNS.domain)) {
    const domain = m[1].toLowerCase();
    if (domain.includes('@')) continue;
    checked.push({ type: 'domain', value: domain });
    if (!inSources(domain)) unsupported.push({ type: 'domain', value: domain });
  }
  for (const m of body.matchAll(PATTERNS.percent)) {
    const value = m[0].replace(/\s/g, '');
    checked.push({ type: 'percent', value });
    if (!inSources(value) && !text.includes(value.replace('%', ' per cent'))) unsupported.push({ type: 'percent', value });
  }
  for (const m of body.matchAll(PATTERNS.dollars)) {
    const value = m[0].replace(/\s/g, '');
    checked.push({ type: 'dollars', value });
    const bare = value.replace(/[$,]/g, '').replace(/\.00$/, '');
    if (!inSources(value) && !text.includes(`$${bare}`) && !user.includes(bare)) unsupported.push({ type: 'dollars', value });
  }
  for (const m of body.matchAll(PATTERNS.form)) {
    // Only when it reads as a form reference, not e.g. "T2 building".
    const context = body.slice(Math.max(0, m.index - 25), m.index + m[0].length + 10).toLowerCase();
    if (!/form|ltb|tribunal|board|notice/.test(context)) continue;
    checked.push({ type: 'form', value: m[1] });
    if (!new RegExp(`\\b${m[1].toLowerCase()}\\b`).test(text)) unsupported.push({ type: 'form', value: m[1] });
  }
  return { checked: checked.length, unsupported };
}

module.exports = { scanAnswer };
