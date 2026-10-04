#!/usr/bin/env node
// Retrieval A/B: production BM25 vs dense embeddings vs a BM25 + dense hybrid,
// on the same labeled cases and metric code as the main eval.
//
//   cd backend/eval/experiments && npm install && npm run dense-retrieval
//
// Dependencies are isolated here (their own package.json) because the model
// runtime is ~380 MB installed, and this is an experiment, not app code. The
// first run downloads the embedding models from the Hugging Face hub.
//
// Fairness rules: every method sees the same query (the pipeline's contextual
// query) and the same intent gating as production (FAQs scoped to the labeled
// intent's category; official passages only for housing/rent intents). Nothing
// is tuned on the eval labels: models are used off the shelf, and the fusion
// uses the standard reciprocal-rank constant k=60.
const path = require('path');
const fs = require('fs');
process.env.SQLITE_PATH = ':memory:';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'unused';
const quiet = console.log;
console.log = () => {};
process.removeAllListeners('warning');

const backend = path.join(__dirname, '..', '..');
const { retrieve } = require(path.join(backend, 'pipeline', 'retrieval'));
const { INTENT_CATEGORY_MAP } = require(path.join(backend, 'pipeline', 'router'));
const { contextualQuery } = require(path.join(backend, 'pipeline', 'memory'));
const { officialSources, allFAQs, SOURCE_INTENTS, scoredFAQs, scoredOfficialSources } = require(path.join(backend, 'lib', 'knowledge'));
const { detectCrisis } = require(path.join(backend, 'lib', 'crisis'));
const { loadDataset } = require(path.join(backend, 'eval', 'lib', 'dataset'));
const { rankingMetrics, latencySummary, round, ratio } = require(path.join(backend, 'eval', 'lib', 'metrics'));
console.log = quiet;

const MODELS = [
  { id: 'Xenova/all-MiniLM-L6-v2', queryPrefix: '' },
  // BGE expects this instruction on queries (not documents) for retrieval.
  { id: 'Xenova/bge-small-en-v1.5', queryPrefix: 'Represent this sentence for searching relevant passages: ' }
];
const K = 5;
const RRF_K = 60;
const isFaq = id => id.startsWith('faq-');
const historyFrom = setup => setup.map((content, i) => ({ id: i + 1, role: 'user', content }));

function cosineTop(queryVec, docVecs, docs, filter, k) {
  const scored = [];
  docs.forEach((doc, i) => {
    if (filter && !filter(doc)) return;
    let dot = 0;
    const v = docVecs[i];
    for (let j = 0; j < v.length; j++) dot += v[j] * queryVec[j];
    scored.push({ id: doc.id, score: dot });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}

// Reciprocal rank fusion of two ranked id lists.
function rrf(listA, listB, k) {
  const scores = new Map();
  for (const list of [listA, listB]) list.forEach((id, rank) => scores.set(id, (scores.get(id) || 0) + 1 / (RRF_K + rank + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => id);
}

async function embedAll(extractor, texts, batch = 16) {
  const out = [];
  for (let i = 0; i < texts.length; i += batch) {
    const t = await extractor(texts.slice(i, i + batch), { pooling: 'mean', normalize: true });
    out.push(...t.tolist());
  }
  return out;
}

function summarizeMethod(rows, name) {
  const passageRows = rows.filter(r => r.labels.passage.length).map(r => ({ relevant: r.labels.passage, retrieved: r[name].passages }));
  const faqRows = rows.filter(r => r.labels.faq.length).map(r => ({ relevant: r.labels.faq, retrieved: r[name].faqs }));
  const labeled = rows.filter(r => r.labels.all.length);
  const ctx = labeled.filter(r => [...r[name].faqs.slice(0, 3), ...r[name].passages.slice(0, 3)].some(id => r.labels.all.includes(id))).length;
  return {
    passages: rankingMetrics(passageRows),
    faqs: rankingMetrics(faqRows),
    contextHitRate: round(ratio(ctx, labeled.length)),
    contextN: labeled.length
  };
}

async function main() {
  const { pipeline } = await import('@huggingface/transformers');
  const { cases } = loadDataset();
  const labeledCases = cases.filter(c => c.expected_source_ids.length);
  const faqs = allFAQs();
  const passageText = s => `${s.heading}. ${s.text}`;
  const faqText = f => `${f.question} ${f.answer}`.replace(/[^\p{L}\p{N}\s.,?!'$%-]/gu, ' ');

  const rows = labeledCases.map(c => {
    const intent = c.expected_intent;
    const history = historyFrom(c.setup);
    const started = process.hrtime.bigint();
    const bm25 = retrieve(c.query, intent, history, { faqTopN: K, sourceTopN: K, crisis: detectCrisis(c.query) });
    const bm25Ms = Number(process.hrtime.bigint() - started) / 1e6;
    return {
      id: c.id, split: c.split, category: c.category, intent,
      query: contextualQuery(c.query, history),
      labels: { all: c.expected_source_ids, faq: c.expected_source_ids.filter(isFaq), passage: c.expected_source_ids.filter(id => !isFaq(id)) },
      bm25: { faqs: bm25.faqs.map(h => h.doc.id), passages: bm25.sources.map(h => h.doc.id), ms: bm25Ms },
      // Control: the same BM25 ranking with the minimum-score cut-offs removed,
      // to separate "better ranker" from "no threshold".
      'bm25-no-threshold': {
        faqs: scoredFAQs(c.query, { topN: K, category: intent ? INTENT_CATEGORY_MAP[intent] : null, minScore: 0 }).map(h => h.doc.id),
        passages: scoredOfficialSources(bm25.query, intent, { topN: K, minScore: 0 }).map(h => h.doc.id)
      }
    };
  });

  const results = { runAt: new Date().toISOString(), cases: rows.length, k: K, methods: {}, bySplit: {}, latencyMs: {}, abstention: {}, notes: [] };

  // Answerable = has a labeled passage; unanswerable = labeled "knowledge base
  // has no answer". Both limited to housing/rent intents, where passages are searched.
  const inPassageScope = c => SOURCE_INTENTS.has(c.expected_intent) && c.expected_intent !== null;
  const answerable = cases.filter(c => inPassageScope(c) && c.expected_source_ids.some(id => !isFaq(id)));
  const unanswerable = cases.filter(c => inPassageScope(c) && c.retrieval_should_be_empty);
  // AUC: probability that a random answerable question's top score beats a
  // random unanswerable one's. 0.5 = the score can't tell them apart.
  async function abstentionAuc(scoreOf) {
    const pos = [];
    const neg = [];
    for (const c of answerable) pos.push(await scoreOf(c));
    for (const c of unanswerable) neg.push(await scoreOf(c));
    let wins = 0;
    for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
    return { auc: round(wins / (pos.length * neg.length)), answerable: pos.length, unanswerable: neg.length };
  }
  const methodNames = ['bm25', 'bm25-no-threshold'];

  for (const model of MODELS) {
    const loadStart = Date.now();
    const extractor = await pipeline('feature-extraction', model.id, { dtype: 'q8' });
    const loadMs = Date.now() - loadStart;
    const indexStart = Date.now();
    const passageVecs = await embedAll(extractor, officialSources.map(passageText));
    const faqVecs = await embedAll(extractor, faqs.map(faqText));
    const indexMs = Date.now() - indexStart;

    const short = model.id.split('/')[1];
    const dense = `dense:${short}`;
    const hybrid = `hybrid:${short}`;
    methodNames.push(dense, hybrid);
    const queryMs = [];
    for (const r of rows) {
      const qStart = process.hrtime.bigint();
      const [qv] = (await extractor([model.queryPrefix + r.query], { pooling: 'mean', normalize: true })).tolist();
      queryMs.push(Number(process.hrtime.bigint() - qStart) / 1e6);
      const category = r.intent ? INTENT_CATEGORY_MAP[r.intent] : null;
      const denseFaqs = cosineTop(qv, faqVecs, faqs, category ? f => f.category === category : null, K).map(x => x.id);
      const densePassages = SOURCE_INTENTS.has(r.intent) ? cosineTop(qv, passageVecs, officialSources, null, K).map(x => x.id) : [];
      r[dense] = { faqs: denseFaqs, passages: densePassages };
      r[hybrid] = { faqs: rrf(r.bm25.faqs, denseFaqs, K), passages: rrf(r.bm25.passages, densePassages, K) };
    }
    results.latencyMs[short] = { modelLoad: loadMs, indexBuild: indexMs, perQueryEmbedding: latencySummary(queryMs) };

    // Abstention: can this model's top passage similarity tell answerable from
    // unanswerable housing/rent questions? (Same cases as BM25's AUC below.)
    const scoreOf = async c => {
      const [qv] = (await extractor([model.queryPrefix + contextualQuery(c.query, historyFrom(c.setup))], { pooling: 'mean', normalize: true })).tolist();
      return cosineTop(qv, passageVecs, officialSources, null, 1)[0].score;
    };
    results.abstention[dense] = await abstentionAuc(scoreOf);
  }
  results.abstention.bm25 = await abstentionAuc(async c => scoredOfficialSources(contextualQuery(c.query, historyFrom(c.setup)), c.expected_intent, { topN: 1, minScore: 0 })[0]?.score || 0);
  results.latencyMs.bm25 = { perQuery: latencySummary(rows.map(r => r.bm25.ms)) };

  for (const name of methodNames) results.methods[name] = summarizeMethod(rows, name);
  for (const split of [...new Set(rows.map(r => r.split))]) {
    const subset = rows.filter(r => r.split === split);
    results.bySplit[split] = Object.fromEntries(methodNames.map(name => [name, summarizeMethod(subset, name)]));
  }
  const hard = rows.filter(r => r.category === 'retrieval_hard');
  results.retrievalHardOnly = Object.fromEntries(methodNames.map(name => [name, summarizeMethod(hard, name)]));
  results.notes.push(
    'Dense and hybrid lists have no minimum-score cut-off, so they always return k results; BM25 returns nothing below its thresholds. Ranking metrics are comparable; the "return nothing when the KB has no answer" behaviour is not measured here.',
    'Hybrid = reciprocal rank fusion (k=60) of the production BM25 list and the dense list.'
  );
  results.perCase = rows.map(r => ({ id: r.id, split: r.split, category: r.category, labels: r.labels.all, ...Object.fromEntries(methodNames.map(n => [n, r[n]])) }));

  const outDir = path.join(backend, 'eval', 'results', 'experiment-dense-retrieval');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');

  const pct = x => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
  const line = (name, m) => `| ${name} | ${pct(m.passages.hitAt[1])} | ${pct(m.passages.hitAt[3])} | ${pct(m.passages.hitAt[5])} | ${m.passages.mrr} | ${pct(m.faqs.hitAt[1])} | ${pct(m.faqs.hitAt[3])} | ${m.faqs.mrr} | ${pct(m.contextHitRate)} |`;
  const header = '| Method | Passage Hit@1 | Hit@3 | Hit@5 | MRR | FAQ Hit@1 | FAQ Hit@3 | FAQ MRR | Context hit |\n|---|---|---|---|---|---|---|---|---|';
  const md = [
    '# Retrieval experiment: BM25 vs dense vs hybrid', '',
    `Run ${results.runAt}. ${rows.length} labeled cases (all splits), k=${K}, same intent gating as production.`, '',
    '## All labeled cases', '', header, ...methodNames.map(n => line(n, results.methods[n])), '',
    `## retrieval_hard only (n=${hard.length})`, '', header, ...methodNames.map(n => line(n, results.retrievalHardOnly[n])), '',
    ...Object.entries(results.bySplit).flatMap(([split, m]) => [`## Split: ${split}`, '', header, ...methodNames.map(n => line(n, m[n])), '']),
    '## Abstention: does the top score separate answerable from unanswerable questions?', '',
    `Housing/rent questions only (where passages are searched): ${results.abstention.bm25.answerable} answerable, ${results.abstention.bm25.unanswerable} unanswerable. AUC of the top passage score; 0.5 = no separation.`, '',
    '| Method | AUC |', '|---|---|', ...Object.entries(results.abstention).map(([k, v]) => `| ${k} | ${v.auc} |`), '',
    '## Latency', '',
    `- BM25 per query: p50 ${results.latencyMs.bm25.perQuery.p50} ms, p95 ${results.latencyMs.bm25.perQuery.p95} ms`,
    ...MODELS.map(m => { const s = m.id.split('/')[1]; const l = results.latencyMs[s]; return `- ${s}: model load ${l.modelLoad} ms, index build ${l.indexBuild} ms, query embedding p50 ${l.perQueryEmbedding.p50} ms / p95 ${l.perQueryEmbedding.p95} ms`; }),
    '', '## Notes', '', ...results.notes.map(n => `- ${n}`), ''
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  quiet(md);
}

main().catch(error => { console.error(error); process.exit(1); });
