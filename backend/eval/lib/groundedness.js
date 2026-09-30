// Deterministic groundedness checks on a pipeline answer. No LLM judge: every
// check here is a string comparison against the context the model was given,
// so the numbers mean the same thing on every run and anyone can audit them.
//
// What these checks can't do: tell whether advice is correct or complete, or
// catch a fabricated claim that contains no number, address or form name.
const { sourcesById, allFAQs } = require('../../lib/knowledge');
const { scanAnswer } = require('./fabrication');

const faqById = Object.fromEntries(allFAQs().map(f => [f.id, f]));

// "UW's policy says…" style claims. Flagged when the context given to the model
// contains no policy text at all, i.e. the claim can't have come from it.
const POLICY_CLAIM = /\b(uw|uwaterloo|university of waterloo|the university|waterloo)('s)?\s+(official\s+)?(policy|policies|rules?\s+(require|say|state)|regulations?)\b|\baccording to (uw|the university|university) policy\b/i;

// The answer prompt tells the model to say, in its own voice, when it doesn't
// have specific details. These phrasings count as acknowledging that.
const UNCERTAINTY = /(don'?t|do not) have (specific|detailed|exact|precise|that|any|up-to-date)|not (sure|certain)|(can'?t|cannot|couldn'?t) (confirm|find|say|verify)|no (specific |official )?information|isn'?t (something|information) i have|i'?m not able to|check (with|directly)|(best|recommend) (to )?(contact|check|ask|reach out)|may (vary|have changed)/i;

function groundedness(c, live) {
  const sourceIds = live.retrieved?.sourceIds || [];
  const faqIds = live.retrieved?.faqIds || [];
  const contextText = [
    ...sourceIds.map(id => sourcesById[id] ? `${sourcesById[id].url} ${sourcesById[id].heading} ${sourcesById[id].text}` : ''),
    ...faqIds.map(id => faqById[id] ? `${faqById[id].question} ${faqById[id].answer}` : '')
  ].join('\n');
  const answer = String(live.answer || '');

  // [n] markers must point at a passage that was actually provided.
  const markers = [...answer.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
  const invalidMarkers = markers.filter(n => n < 1 || n > sourceIds.length);
  const citedIds = [...new Set(markers.filter(n => n >= 1 && n <= sourceIds.length).map(n => sourceIds[n - 1]))];

  const labeledPassages = c.expected_source_ids.filter(id => !id.startsWith('faq-'));
  const labeledGiven = sourceIds.filter(id => labeledPassages.includes(id));

  return {
    contextChars: contextText.length,
    markers: markers.length,
    invalidMarkers,
    citedIds,
    // Only meaningful when a labeled passage was among those given.
    citesLabeledSource: labeledGiven.length ? citedIds.some(id => labeledPassages.includes(id)) : null,
    citedButUnlabeled: labeledPassages.length ? citedIds.filter(id => !labeledPassages.includes(id)) : [],
    contextUnsupported: scanAnswer(answer, { userText: [...c.setup, c.query].join(' '), contextText }).unsupported,
    policyClaimWithoutContext: POLICY_CLAIM.test(answer) && !/\bpolic(y|ies)\b/i.test(contextText),
    acknowledgesUncertainty: UNCERTAINTY.test(answer)
  };
}

module.exports = { groundedness, POLICY_CLAIM, UNCERTAINTY };
