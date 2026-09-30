// Renders eval-results.json as a readable Markdown report. Pure: the report
// can be regenerated from the JSON alone (node eval/report.js <results.json>).

const pct = x => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const num = x => (x === null || x === undefined ? 'n/a' : String(x));
const esc = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const clip = (s, n = 160) => { const t = esc(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

function failureTable(items, { limit = 60 } = {}) {
  if (!items?.length) return '_None._';
  const rows = items.slice(0, limit).map(f => [`\`${f.id}\``, f.type ? `**${f.type}**` : esc(f.category), clip(f.input, 140), clip(f.expected, 90), clip(f.actual, 140), clip(f.why, 120)]);
  const more = items.length > limit ? `\n\n…and ${items.length - limit} more in eval-results.json.` : '';
  return table(['Case', items[0].type ? 'Type' : 'Category', 'Input', 'Expected', 'Actual', 'Why'], rows) + more;
}

function renderReport(results) {
  const { meta, metrics: m, failures: f } = results;
  const out = [];
  out.push(`# Eval report: ${meta.mode}${meta.label ? ` (${meta.label})` : ''}`);
  out.push('');
  out.push(table(['', ''], [
    ['Run at', meta.finishedAt],
    ['Mode', meta.mode],
    ['Model', meta.model || 'none (deterministic components only)'],
    ['Dataset', `v${meta.datasetVersion}, ${meta.casesRun} of ${meta.datasetSize} cases run${meta.filters.split ? ` (split: ${meta.filters.split})` : ''}${meta.filters.category ? ` (categories: ${meta.filters.category.join(', ')})` : ''}${meta.filters.ids ? ` (ids: ${meta.filters.ids.length})` : ''}`],
    ['Code', `${meta.git.commit || 'unknown'}${meta.git.dirty ? ' + uncommitted changes' : ''}`],
    ['Node', meta.node],
    ...(meta.replayedFrom ? [['Router outputs', `replayed from ${esc(meta.replayedFrom)} (no new API calls)`]] : []),
    ...(meta.aborted ? [['**Stopped early**', esc(meta.aborted)]] : [])
  ]));
  out.push('');
  out.push('## Headline');
  out.push('');
  for (const line of results.headline) out.push(`- ${line}`);
  out.push('');

  if (m.routing) {
    const r = m.routing;
    out.push('## Intent routing');
    out.push('');
    out.push(`${r.definition}`);
    out.push('');
    out.push(table(['Metric', 'Value'], [
      ['Cases (labeled intent)', r.n], ['Accuracy (acceptable intents allowed)', pct(r.accuracy)], ['Strict accuracy', pct(r.strictAccuracy)],
      ['Accuracy after critic override', pct(r.finalAccuracy)], ['Macro F1', num(r.macroF1)], ['Router returned nothing', r.routerFailed],
      ['Mean confidence: correct / incorrect', `${num(r.confidence.correct.mean)} / ${num(r.confidence.incorrect.mean)}`]
    ]));
    out.push('');
    out.push('### Per class');
    out.push('');
    out.push(table(['Intent', 'Precision', 'Recall', 'F1', 'Support', 'Predicted'], Object.entries(r.perClass).map(([k, v]) => [k, pct(v.precision), pct(v.recall), num(v.f1), v.support, v.predicted])));
    out.push('');
    out.push('### Confusion matrix (rows = expected, columns = predicted)');
    out.push('');
    const { labels, columns, matrix } = r.confusion;
    const short = s => ({ health_safety: 'health', rent_money: 'rent', out_of_scope: 'oos' }[s] || s);
    out.push(table(['expected \\ predicted', ...columns.map(short)], labels.map(l => [short(l), ...columns.map(c => (matrix[l][c] ? (l === c ? `**${matrix[l][c]}**` : matrix[l][c]) : '·'))])));
    out.push('');
    out.push('### By category');
    out.push('');
    out.push(table(['Category', 'n', 'Accuracy'], Object.entries(r.byCategory).sort((a, b) => a[1].accuracy - b[1].accuracy).map(([k, v]) => [k, v.n, pct(v.accuracy)])));
    out.push('');
  }

  const ret = m.retrieval;
  out.push('## Retrieval');
  out.push('');
  out.push(ret.definition);
  out.push('');
  const rk = (x, k) => pct(x.hitAt[k]);
  out.push(table(['Index', 'Scoping', 'n', 'Hit@1', 'Hit@3', 'Hit@5', 'Recall@5', 'MRR'], [
    ['Official passages', 'labeled intent', ret.passages.goldIntent.n, rk(ret.passages.goldIntent, 1), rk(ret.passages.goldIntent, 3), rk(ret.passages.goldIntent, 5), pct(ret.passages.goldIntent.recallAt[5]), num(ret.passages.goldIntent.mrr)],
    ['Official passages', 'ungated', ret.passages.ungated.n, rk(ret.passages.ungated, 1), rk(ret.passages.ungated, 3), rk(ret.passages.ungated, 5), pct(ret.passages.ungated.recallAt[5]), num(ret.passages.ungated.mrr)],
    ['FAQs', 'labeled intent', ret.faqs.goldIntent.n, rk(ret.faqs.goldIntent, 1), rk(ret.faqs.goldIntent, 3), rk(ret.faqs.goldIntent, 5), pct(ret.faqs.goldIntent.recallAt[5]), num(ret.faqs.goldIntent.mrr)],
    ['FAQs', 'ungated', ret.faqs.ungated.n, rk(ret.faqs.ungated, 1), rk(ret.faqs.ungated, 3), rk(ret.faqs.ungated, 5), pct(ret.faqs.ungated.recallAt[5]), num(ret.faqs.ungated.mrr)]
  ]));
  out.push('');
  out.push(table(['Context the model receives (top 3 + top 3)', 'Value'], [
    ['Cases with labeled sources', ret.context.n],
    ['≥1 labeled source in context, labeled intent', pct(ret.context.goldIntentHitRate)],
    ['≥1 labeled source in context, ungated', pct(ret.context.ungatedHitRate)],
    ...(ret.context.endToEndHitRate !== undefined ? [['≥1 labeled source in context, end to end (router-chosen intent)', pct(ret.context.endToEndHitRate)]] : []),
    [`Nothing retrieved when the KB has no answer (n=${ret.emptyWhenNothingRelevant.n})`, pct(ret.emptyWhenNothingRelevant.rate)],
    ['Retrieval latency p50 / p95 (ms)', `${num(ret.latencyMs.p50)} / ${num(ret.latencyMs.p95)}`]
  ]));
  out.push('');
  out.push(table(['Category', 'n', 'Context hit rate'], Object.entries(ret.byCategory).sort((a, b) => a[1].contextHitRate - b[1].contextHitRate).map(([k, v]) => [k, v.n, pct(v.contextHitRate)])));
  out.push('');

  const s = m.safety;
  out.push('## Safety (escalation to a person)');
  out.push('');
  out.push(s.definition);
  out.push('');
  const safetyRow = (name, x) => [name, x.n, x.tp, x.fn, x.fp, pct(x.recall), pct(x.precision), pct(x.falseNegativeRate), pct(x.falsePositiveRate), pct(x.hardNegativeFalsePositiveRate)];
  out.push(table(['Layer', 'n', 'TP', '**FN**', 'FP', 'Recall', 'Precision', 'FNR', 'FPR', 'FPR on hard negatives'], [
    safetyRow('Rules only (model-free)', s.rules),
    ...(s.system ? [safetyRow(`System: ${s.system.scope}`, s.system)] : [])
  ]));
  out.push('');
  out.push(`Rules: crisis category correct on ${pct(s.rules.crisisCategoryAccuracy)} of labeled crises. Recall by type: ${Object.entries(s.rules.recallByCrisisType).map(([k, v]) => `${k} ${pct(v.recall)} (n=${v.n})`).join(', ')}.`);
  out.push('');

  if (m.tools) {
    const t = m.tools;
    out.push('## Tool calling');
    out.push('');
    out.push(t.definition);
    out.push('');
    out.push(table(['Metric', 'Value'], [
      ['Cases with a tool label', t.n], ['Agent tool-selection accuracy', pct(t.agentSelectionAccuracy)], ['System tool-selection accuracy (incl. critic)', pct(t.systemSelectionAccuracy)],
      ['Act / don\'t act: precision, recall', `${pct(t.actDecision.precision)}, ${pct(t.actDecision.recall)}`],
      ['Tool calls made by the agent', t.toolCalls], ['Execution success rate', pct(t.executionSuccessRate)],
      ['Invalid or hallucinated tool calls', `${t.invalidOrHallucinatedCalls} (${pct(t.invalidOrHallucinatedRate)})`],
      ['Action agent runs', t.actionAgentRuns], ['Guardrail checks violated', `${t.guardrailChecks.violations} of ${t.guardrailChecks.n}`]
    ]));
    out.push('');
  }

  if (m.agentTools) {
    const t = m.agentTools;
    out.push('## Action agent (tool calling)');
    out.push('');
    out.push(t.definition);
    out.push('');
    out.push(table(['Metric', 'Value'], [
      ['Cases', t.n], ['Accuracy (action level + required draft)', pct(t.accuracy)],
      ...Object.entries(t.bySplit).map(([k, v]) => [`Accuracy, ${k} split (n=${v.n})`, pct(v.accuracy)]),
      [`False tool-call rate (tool called when none was needed, n=${t.noToolCases})`, pct(t.falseToolCallRate)],
      ['Raw model tool calls', t.rawToolCalls], ['Hallucinated tool rate', pct(t.hallucinatedToolRate)], ['Malformed argument rate (vs the JSON schema)', pct(t.malformedArgumentRate)],
      ['Loop-bound compliance (≤4 model turns, ≤6 tool calls)', pct(t.boundedLoopCompliance)], ['Guardrail checks violated', `${t.guardrailChecks.violations} of ${t.guardrailChecks.n}`],
      ['Agent latency p50 / p95 (ms)', `${num(t.latencyMs.p50)} / ${num(t.latencyMs.p95)}`]
    ]));
    out.push('');
    out.push(table(['Tool', 'Expected in', 'Called in', 'Recall', 'Precision'], Object.entries(t.perTool).map(([k, v]) => [k, v.expected, v.called, pct(v.recall), pct(v.precision)])));
    out.push('');
    out.push('Action level confusion (rows = expected, columns = what the agent did):');
    out.push('');
    out.push(table(['expected \\ actual', ...t.levelConfusion.labels], t.levelConfusion.labels.map(l => [l, ...t.levelConfusion.labels.map(c => t.levelConfusion.matrix[l][c] || '·')])));
    out.push('');
  }

  if (m.answers) {
    const a = m.answers;
    out.push('## Answers');
    out.push('');
    out.push(table(['Metric', 'Value'], [
      ['Answers produced', a.n],
      [`Cites ≥1 official passage when passages were given (n=${a.citedWhenSourcesGiven.n})`, pct(a.citedWhenSourcesGiven.rate)],
      ['Answer checks (injection, unsupported actions) violated', `${a.answerChecks.violations} of ${a.answerChecks.n}`],
      ['Answers with unsupported specifics (heuristic)', `${a.unsupportedSpecifics.answersFlagged} (${pct(a.unsupportedSpecifics.rate)})`]
    ]));
    out.push('');
    if (a.grounding) {
      const g = a.grounding;
      out.push('### Groundedness (deterministic)');
      out.push('');
      out.push(g.definition);
      out.push('');
      out.push(table(['Check', 'Value'], [
        [`Answers with a citation marker that points at no provided passage (n=${g.invalidCitationRate.n} answers with markers)`, pct(g.invalidCitationRate.rate)],
        [`Cites a labeled-correct passage when one was provided (n=${g.citesLabeledSourceWhenGiven.n})`, pct(g.citesLabeledSourceWhenGiven.rate)],
        [`Answers stating a number/address/form not in their own context (n=${g.specificsNotInContext.n})`, `${g.specificsNotInContext.answersFlagged} (${pct(g.specificsNotInContext.rate)})`],
        ['University-policy claims with no policy text in context', g.policyClaimsWithoutContext],
        [`Unanswerable questions: answer acknowledges missing information (n=${g.unanswerable.n})`, pct(g.unanswerable.acknowledgesUncertainty)],
        ['Unanswerable questions: answers with unsupported specifics', g.unanswerable.withUnsupportedSpecifics]
      ]));
      out.push('');
    }
  }

  if (m.reliability) {
    const r = m.reliability;
    out.push('## Reliability');
    out.push('');
    out.push(table(['Metric', 'Value'], Object.entries(r).map(([k, v]) => [k, typeof v === 'number' && v <= 1 && /Rate$/.test(k) ? pct(v) : num(v)])));
    out.push('');
  }

  out.push('## Latency (ms)');
  out.push('');
  const lat = [];
  const addLat = (name, x) => x?.n && lat.push([name, x.n, num(x.mean), num(x.p50), num(x.p95), num(x.max)]);
  addLat('Retrieval (BM25)', m.latencyMs.retrieval);
  addLat('Crisis rules', m.latencyMs.crisisRules);
  for (const [k, v] of Object.entries(m.latencyMs.llmByStage || {})) addLat(`LLM call: ${k}`, v);
  for (const [k, v] of Object.entries(m.latencyMs.pipelineStages || {})) addLat(`Pipeline stage: ${k}`, v);
  addLat('**End to end**', m.latencyMs.endToEnd);
  out.push(table(['Measure', 'n', 'Mean', 'p50', 'p95', 'Max'], lat));
  out.push('');
  if (m.latencyMs.pipelineStages?.retrieval) out.push('The pipeline "retrieval" stage includes streaming the generated answer, so it is mostly LLM time.\n');

  if (m.tokens) {
    const t = m.tokens;
    out.push('## Tokens');
    out.push('');
    out.push(table(['Stage', 'Calls', 'Avg input', 'Avg output'], Object.entries(t.perStage).map(([k, v]) => [k, v.calls, num(v.avgInput), num(v.avgOutput)])));
    out.push('');
    out.push(`Per case: ${num(t.perCase.avgInput)} input + ${num(t.perCase.avgOutput)} output tokens on average (${t.callsWithoutUsage} calls reported no usage). Total: ${t.totalInput} in / ${t.totalOutput} out. Estimated cost per case: ${t.estimatedCostPerCaseUSD === null ? 'not computed (set EVAL_PRICE_INPUT_PER_M and EVAL_PRICE_OUTPUT_PER_M from the provider\'s current price list)' : `$${t.estimatedCostPerCaseUSD}`}.`);
    out.push('');
  }

  out.push('## Worst-performing categories');
  out.push('');
  out.push(table(['Category', 'Cases', 'Lowest score', 'Scores'], m.worstCategories.map(w => [w.category, w.n, pct(w.worst), Object.entries(w.scores).map(([k, v]) => `${k} ${pct(v)}`).join(', ')])));
  out.push('');

  out.push('## Failures');
  out.push('');
  const sections = [
    ['Safety: rules layer', f.safetyRules], ['Safety: whole system', f.safetySystem], ['Routing', f.routing], ['Retrieval misses (labeled intent)', f.retrieval],
    ['Retrieval false matches (context given when the KB has no answer)', f.retrievalFalseMatches], ['Tool selection', f.tools], ['Tool guardrails', f.toolGuardrails],
    ['Action agent decisions', f.agentTools], ['Action agent: invalid or hallucinated calls', f.agentMalformed], ['Action agent guardrails', f.agentGuardrails],
    ['Answer checks', f.answerChecks], ['Groundedness', f.grounding], ['Unsupported specifics (heuristic, review manually)', f.unsupportedSpecifics], ['Errored cases', f.errors]
  ];
  for (const [title, items] of sections) {
    if (items === undefined) continue;
    out.push(`### ${title} (${items.length})`);
    out.push('');
    out.push(failureTable(items));
    out.push('');
  }
  return out.join('\n');
}

module.exports = { renderReport };
