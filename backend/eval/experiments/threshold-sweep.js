#!/usr/bin/env node
// BM25 cut-off sweep. The retrieval A/B found that BM25 with its minimum-score
// cut-offs removed reaches a much higher context hit rate, so the cut-offs,
// not the ranker, are a large part of the gap. Lowering them trades recall for
// false matches (unrelated context on questions the knowledge base can't
// answer), so both are measured.
//
// Decision rule, fixed before the sweep was run: pick the (FAQ, passage) pair
// with the highest DEV context hit rate whose DEV in-scope false-match rate is
// at most 10%; report FRESH once for the chosen pair. No dependencies.
//
//   node eval/experiments/threshold-sweep.js
const path = require('path');
const fs = require('fs');
process.env.SQLITE_PATH = ':memory:';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'unused';
const quiet = console.log;
console.log = () => {};
const backend = path.join(__dirname, '..', '..');
const { retrieve } = require(path.join(backend, 'pipeline', 'retrieval'));
const { detectCrisis } = require(path.join(backend, 'lib', 'crisis'));
const { FAQ_MIN_SCORE, SOURCE_MIN_SCORE } = require(path.join(backend, 'lib', 'knowledge'));
const { loadDataset } = require(path.join(backend, 'eval', 'lib', 'dataset'));
console.log = quiet;

const FAQ_GRID = [5, 4.5, 4, 3.5, 3, 2.5];
const SOURCE_GRID = [6, 5.5, 5, 4.5, 4];
const MAX_FALSE_MATCH = 0.10;
const historyFrom = setup => setup.map((content, i) => ({ id: i + 1, role: 'user', content }));

function score(cases, faqMinScore, sourceMinScore) {
  const run = c => retrieve(c.query, c.expected_intent, historyFrom(c.setup), { crisis: detectCrisis(c.query), faqMinScore, sourceMinScore });
  const labeled = cases.filter(c => c.expected_source_ids.length);
  // In scope = the pipeline would retrieve for it (out_of_scope skips retrieval).
  const negatives = cases.filter(c => c.retrieval_should_be_empty && c.expected_intent && c.expected_intent !== 'out_of_scope');
  const hits = labeled.filter(c => { const r = run(c); return [...r.faqs, ...r.sources].some(h => c.expected_source_ids.includes(h.doc.id)); }).length;
  const falseMatches = negatives.filter(c => { const r = run(c); return r.faqs.length || r.sources.length; });
  return { contextHit: hits / labeled.length, n: labeled.length, falseMatchRate: negatives.length ? falseMatches.length / negatives.length : null, negatives: negatives.length, falseMatchIds: falseMatches.map(c => c.id) };
}

const { cases } = loadDataset();
const dev = cases.filter(c => c.split === 'dev');
const fresh = cases.filter(c => c.split === 'fresh');
const rows = [];
for (const f of FAQ_GRID) for (const p of SOURCE_GRID) rows.push({ faq: f, passage: p, dev: score(dev, f, p) });
const current = rows.find(r => r.faq === FAQ_MIN_SCORE && r.passage === SOURCE_MIN_SCORE);
const eligible = rows.filter(r => r.dev.falseMatchRate <= MAX_FALSE_MATCH).sort((a, b) => b.dev.contextHit - a.dev.contextHit || b.faq - a.faq || b.passage - a.passage);
const chosen = eligible[0] || null;
const pct = x => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);

const lines = ['# BM25 cut-off sweep', '', `Run ${new Date().toISOString()}. Production cut-offs: FAQ ${FAQ_MIN_SCORE}, passage ${SOURCE_MIN_SCORE}. Rule (fixed before running): max dev context hit with dev in-scope false-match rate ≤ ${100 * MAX_FALSE_MATCH}%.`, '',
  `| FAQ min | Passage min | Dev context hit (n=${current.dev.n}) | Dev false-match rate (n=${current.dev.negatives}) |`, '|---|---|---|---|',
  ...rows.map(r => `| ${r.faq} | ${r.passage} | ${pct(r.dev.contextHit)} | ${pct(r.dev.falseMatchRate)} |`), ''];
const freshCurrent = score(fresh, FAQ_MIN_SCORE, SOURCE_MIN_SCORE);
const row = (label, faq, passage, d, fr) => `| ${label} (${faq}, ${passage}) | ${pct(d.contextHit)} | ${pct(d.falseMatchRate)} (${d.falseMatchIds.join(', ') || 'none'}) | ${pct(fr.contextHit)} (n=${fr.n}) | ${pct(fr.falseMatchRate)} of ${fr.negatives} (${fr.falseMatchIds.join(', ') || 'none'}) |`;
const header = ['| | Dev context hit | Dev false matches | Fresh context hit | Fresh false matches |', '|---|---|---|---|---|'];
if (chosen) {
  const freshChosen = score(fresh, chosen.faq, chosen.passage);
  lines.push(`**Chosen:** FAQ ${chosen.faq}, passage ${chosen.passage}.`, '', ...header, row('Current', FAQ_MIN_SCORE, SOURCE_MIN_SCORE, current.dev, freshCurrent), row('Chosen', chosen.faq, chosen.passage, chosen.dev, freshChosen), '');
} else {
  const loosest = rows.at(-1);
  lines.push(`**No pair meets the rule, the current cut-offs included, so they stay as they are.** Lowering them raises context hit on dev but also the share of unanswerable questions that get unrelated context.`, '', ...header,
    row('Current', FAQ_MIN_SCORE, SOURCE_MIN_SCORE, current.dev, freshCurrent),
    row('Loosest tried', loosest.faq, loosest.passage, loosest.dev, score(fresh, loosest.faq, loosest.passage)), '');
}
const out = path.join(backend, 'eval', 'results', 'experiment-threshold-sweep');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'report.md'), lines.join('\n'));
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ rows, chosen, current, freshCurrent }, null, 2));
quiet(lines.join('\n'));
