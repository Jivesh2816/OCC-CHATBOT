// Turns per-case records from eval/run.js into metrics and a failure list.
// Every metric states its denominator (n), and cases whose model calls failed
// even after retries are excluded from quality metrics and counted under
// reliability instead, so an API outage can't masquerade as a wrong answer.
const { VALID_INTENTS } = require('../../pipeline/router');
const { classificationReport, rankingMetrics, binaryMetrics, latencySummary, ratio, round } = require('./metrics');
const { classifyToolCalls, summarizeToolCalls } = require('./tool-calls');
const { requiredTools, primaryTool } = require('./dataset');

const isFaq = id => id.startsWith('faq-');
const groupBy = (items, key) => items.reduce((acc, item) => ((acc[key(item)] ||= []).push(item), acc), {});
const pct = x => (x === null || x === undefined ? 'n/a' : `${(100 * x).toFixed(1)}%`);

function intentOk(c, predicted) {
  return predicted === c.expected_intent || c.acceptable_intents.includes(predicted);
}

function toolsCalled(record) {
  return new Set((record.live?.agentTools || []).map(t => t.tool));
}

function toolOk(expected, called) {
  if (expected === 'none') return called.size === 0;
  return called.has(expected);
}

// Action levels: what the agent decided to do, ignoring drafts.
const LEVELS = ['none', 'create', 'escalate'];
const levelOf = tools => (tools.has('escalate_ticket') ? 'escalate' : tools.has('create_ticket') ? 'create' : 'none');
const TOOL_KEYS = ['create_ticket', 'escalate_ticket', 'draft_followup_email'];
// A case's expected-actions label and its acceptable alternatives (eval/lib/dataset.js).
const alternatives = c => [c.expected_actions, ...c.acceptable_actions];
// Does a set of called tools satisfy one expected-actions label? The ticket level must
// match; draft true requires a draft, draft false forbids one, draft null ignores it.
const satisfies = (a, tools) => levelOf(tools) === a.ticket && (a.draft !== true || tools.has('draft_followup_email')) && (a.draft !== false || !tools.has('draft_followup_email'));

// One row per invalid call, labeled with its kind (see lib/tool-calls.js).
const KIND_LABELS = { hallucinated: 'hallucinated tool', malformedArguments: 'malformed arguments', providerRejected: 'provider-rejected tool call', serverRejected: 'server-side rejection' };
function toolCallFailures(rows) {
  return rows.flatMap(({ c, problems }) => Object.keys(KIND_LABELS).flatMap(kind => problems[kind].map(p => ({
    id: c.id, category: c.category, input: c.query, expected: 'a valid call to an existing tool', actual: `${KIND_LABELS[kind]}: ${p.tool ?? 'unknown tool'}`, why: p.why
  }))));
}

function agentMetrics(ok, failures, headline) {
  const called = r => new Set(r.live.tools.map(t => t.tool));
  // Correct if the calls satisfy the expected actions or an acceptable alternative.
  const correct = ({ r, c }) => alternatives(c).some(a => satisfies(a, called(r)));
  const matrix = Object.fromEntries(LEVELS.map(l => [l, Object.fromEntries(LEVELS.map(m => [m, 0]))]));
  for (const { r, c } of ok) matrix[c.expected_actions.ticket][levelOf(called(r))]++;
  // Drafting is scored only where the label says whether a draft is expected.
  const draftSpecified = c => alternatives(c).every(a => a.draft !== null);
  const perTool = Object.fromEntries(TOOL_KEYS.map(tool => {
    const should = ok.filter(({ c }) => requiredTools(c.expected_actions).includes(tool));
    const scoredOn = tool === 'draft_followup_email' ? ok.filter(({ c }) => draftSpecified(c)) : ok;
    const did = scoredOn.filter(({ r }) => called(r).has(tool));
    const justified = did.filter(({ c }) => alternatives(c).some(a => requiredTools(a).includes(tool)));
    const silent = ok.filter(({ r, c }) => !scoredOn.some(x => x.c === c) && called(r).has(tool)).length;
    return [tool, { expected: should.length, called: did.length + silent, calledWhereLabelSilent: silent, recall: round(ratio(should.filter(({ r }) => called(r).has(tool)).length, should.length)), precision: round(ratio(justified.length, did.length)) }];
  }));
  const noneCases = ok.filter(({ c }) => c.expected_actions.ticket === 'none');
  // Over-escalation: escalated where no acceptable label escalates but one opens a ticket.
  // Under-escalation: the expected label escalates and the agent did not.
  const ticketOnly = rows => rows.filter(({ c }) => alternatives(c).some(a => a.ticket === 'create') && !alternatives(c).some(a => a.ticket === 'escalate'));
  const mustEscalate = rows => rows.filter(({ c }) => c.expected_actions.ticket === 'escalate');
  const escalationErrors = rows => ({
    ticketOnlyCases: ticketOnly(rows).length,
    ticketOnlyEscalated: ticketOnly(rows).filter(({ r }) => levelOf(called(r)) === 'escalate').length,
    escalateCases: mustEscalate(rows).length,
    escalateDowngraded: mustEscalate(rows).filter(({ r }) => levelOf(called(r)) !== 'escalate').length
  });
  const callProblems = ok.map(x => ({ ...x, problems: classifyToolCalls(x.r.live.llm, x.r.live.tools) }));
  const callQuality = summarizeToolCalls(callProblems.map(x => x.problems));
  const bounded = ok.filter(({ r }) => r.live.modelTurns <= 4 && r.live.tools.length <= 6);
  const withChecks = ok.filter(({ c }) => c.tool_checks);
  const violations = ({ r, c }) => {
    const v = [];
    const tc = c.tool_checks;
    const created = r.live.tickets.length;
    if (tc.max_tickets !== undefined && created > tc.max_tickets) v.push(`${created} tickets (max ${tc.max_tickets})`);
    for (const p of tc.forbid_priority || []) if (r.live.tickets.some(t => t.priority === p)) v.push(`ticket stored with priority "${p}"`);
    if (tc.forbid_arg_pattern && r.live.tools.some(t => new RegExp(tc.forbid_arg_pattern, 'i').test(JSON.stringify(t.args)))) v.push(`arguments matched /${tc.forbid_arg_pattern}/`);
    return v;
  };
  const bySplit = Object.fromEntries(Object.entries(groupBy(ok, ({ c }) => c.split)).map(([k, rows]) => [k, { n: rows.length, accuracy: round(ratio(rows.filter(correct).length, rows.length)), ...escalationErrors(rows) }]));
  const agentTools = {
    definition: "The action agent alone, given the labeled intent (no router gating, no critic backstop). Labels are multi-action (expected_actions: ticket none / create / escalate, plus draft true / false / null); correct = the calls satisfy the label or an acceptable alternative. Per-tool recall/precision: did the agent call each tool the label requires; draft_followup_email precision counts only cases whose label says whether a draft is expected (drafts where the label is silent are listed separately, not scored). Over-escalation = escalated where no acceptable label escalates; under-escalation = did not escalate where the label does. Invalid tool calls are split by kind (eval/lib/tool-calls.js).",
    n: ok.length,
    accuracy: round(ratio(ok.filter(correct).length, ok.length)),
    bySplit,
    levelConfusion: { labels: LEVELS, matrix },
    escalation: escalationErrors(ok),
    perTool,
    falseToolCallRate: round(ratio(noneCases.filter(({ r }) => called(r).size > 0).length, noneCases.length)),
    noToolCases: noneCases.length,
    rawToolCalls: callQuality.rawToolCalls,
    hallucinatedToolRate: callQuality.hallucinatedToolRate,
    malformedArgumentRate: callQuality.malformedArgumentRate,
    callQuality,
    boundedLoopCompliance: round(ratio(bounded.length, ok.length)),
    guardrailChecks: { n: withChecks.length, violations: withChecks.filter(x => violations(x).length).length },
    latencyMs: latencySummary(ok.map(({ r }) => r.live.totalMs))
  };
  failures.agentTools = ok.filter(x => !correct(x)).map(({ r, c }) => ({
    id: c.id, category: c.category, input: c.query,
    expected: alternatives(c).map(a => `${a.ticket}${a.draft === true ? ' + draft' : ''}`).join(' | '),
    actual: [...called(r)].join(', ') || 'no tool calls',
    why: levelOf(called(r)) === 'none' ? 'agent took no action'
      : c.expected_actions.ticket === 'none' ? 'agent acted on a message that needed no action'
        : `agent chose level "${levelOf(called(r))}" (ticket priority ${r.live.tools.find(t => t.tool === 'create_ticket')?.priority ?? 'n/a'})`
  }));
  failures.agentMalformed = toolCallFailures(callProblems);
  failures.agentGuardrails = withChecks.filter(x => violations(x).length).map(x => ({ id: x.c.id, category: x.c.category, input: x.c.query, expected: JSON.stringify(x.c.tool_checks), actual: violations(x).join('; '), why: 'model-controlled arguments got past validation' }));
  headline.push(`agent tools: accuracy ${pct(agentTools.accuracy)} over ${ok.length} cases; false tool-call rate ${pct(agentTools.falseToolCallRate)} (n=${noneCases.length}); hallucinated ${callQuality.counts.hallucinated}/${callQuality.rawToolCalls}, malformed args ${callQuality.counts.malformedArguments}/${callQuality.rawToolCalls}, provider-rejected ${callQuality.counts.providerRejected}/${callQuality.actionTurns} turns`);
  return { agentTools };
}

// Deterministic groundedness over pipeline answers (see eval/lib/groundedness.js).
function groundingMetrics(answered) {
  const rows = answered.filter(({ r }) => r.live.groundedness);
  const g = ({ r }) => r.live.groundedness;
  const withMarkers = rows.filter(x => g(x).markers > 0);
  const labeledGiven = rows.filter(x => g(x).citesLabeledSource !== null);
  const unanswerable = rows.filter(({ c }) => c.retrieval_should_be_empty || c.category === 'security_fabrication');
  return {
    definition: 'All deterministic (no LLM judge). Context = the FAQs and passages actually given to the answer model. Unanswerable = cases the knowledge base cannot answer (retrieval_should_be_empty, security_fabrication).',
    n: rows.length,
    invalidCitationRate: { n: withMarkers.length, rate: round(ratio(withMarkers.filter(x => g(x).invalidMarkers.length).length, withMarkers.length)) },
    citesLabeledSourceWhenGiven: { n: labeledGiven.length, rate: round(ratio(labeledGiven.filter(x => g(x).citesLabeledSource).length, labeledGiven.length)) },
    specificsNotInContext: { n: rows.length, answersFlagged: rows.filter(x => g(x).contextUnsupported.length).length, rate: round(ratio(rows.filter(x => g(x).contextUnsupported.length).length, rows.length)) },
    policyClaimsWithoutContext: rows.filter(x => g(x).policyClaimWithoutContext).length,
    unanswerable: {
      n: unanswerable.length,
      acknowledgesUncertainty: round(ratio(unanswerable.filter(x => g(x).acknowledgesUncertainty).length, unanswerable.length)),
      withUnsupportedSpecifics: unanswerable.filter(x => g(x).contextUnsupported.length).length
    }
  };
}

function summarize({ meta, records, casesById }) {
  const mode = meta.mode;
  const live = mode !== 'offline';
  const hasRouter = mode === 'router' || mode === 'pipeline';
  const all = records.map(r => ({ r, c: casesById[r.id] }));
  const ok = all.filter(({ r }) => !live || (!r.error && r.live));
  const metrics = {};
  const failures = {};
  const headline = [];

  // ---------------------------------------------------------------- routing
  if (hasRouter) {
    const rawIntent = r => (mode === 'router' ? r.live.router.intent : r.live.routerIntent);
    const finalIntent = r => (mode === 'router' ? r.live.finalIntent : r.live.intent);
    const labeled = ok.filter(({ c }) => c.expected_intent !== null);
    const lenientPairs = labeled.map(({ r, c }) => ({ expected: c.expected_intent, predicted: intentOk(c, rawIntent(r)) ? c.expected_intent : rawIntent(r) }));
    const report = classificationReport(lenientPairs, VALID_INTENTS);
    const strict = labeled.filter(({ r, c }) => rawIntent(r) === c.expected_intent).length;
    const finalCorrect = labeled.filter(({ r, c }) => intentOk(c, finalIntent(r))).length;
    const byCat = groupBy(labeled, ({ c }) => c.category);
    const byDiff = groupBy(labeled, ({ c }) => c.difficulty);
    const conf = rows => latencySummary(rows.map(({ r }) => (mode === 'router' ? r.live.router.confidence : r.live.routerConfidence)));
    metrics.routing = {
      definition: 'Router LLM output vs expected_intent. "accuracy" accepts acceptable_intents; strictAccuracy does not. finalAccuracy is after the critic pre-check override.',
      n: labeled.length,
      accuracy: report.accuracy,
      strictAccuracy: round(ratio(strict, labeled.length)),
      finalAccuracy: round(ratio(finalCorrect, labeled.length)),
      macroF1: report.macroF1,
      routerFailed: ok.filter(({ r }) => rawIntent(r) === null).length,
      perClass: report.perClass,
      confusion: report.confusion,
      byCategory: Object.fromEntries(Object.entries(byCat).map(([k, rows]) => [k, { n: rows.length, accuracy: round(ratio(rows.filter(({ r, c }) => intentOk(c, rawIntent(r))).length, rows.length)) }])),
      byDifficulty: Object.fromEntries(Object.entries(byDiff).map(([k, rows]) => [k, { n: rows.length, accuracy: round(ratio(rows.filter(({ r, c }) => intentOk(c, rawIntent(r))).length, rows.length)) }])),
      confidence: {
        correct: conf(labeled.filter(({ r, c }) => intentOk(c, rawIntent(r)))),
        incorrect: conf(labeled.filter(({ r, c }) => !intentOk(c, rawIntent(r))))
      }
    };
    failures.routing = labeled.filter(({ r, c }) => !intentOk(c, rawIntent(r))).map(({ r, c }) => ({
      id: c.id, category: c.category, input: c.query, setup: c.setup,
      expected: [c.expected_intent, ...c.acceptable_intents].join(' | '),
      actual: String(rawIntent(r)),
      why: rawIntent(r) === null ? 'router returned no valid intent after 2 attempts' : `routed to ${rawIntent(r)} (confidence ${mode === 'router' ? r.live.router.confidence : r.live.routerConfidence})`
    }));
    headline.push(`routing accuracy ${pct(metrics.routing.accuracy)} (strict ${pct(metrics.routing.strictAccuracy)}, macro-F1 ${metrics.routing.macroF1}) over ${labeled.length} cases`);
  }

  // -------------------------------------------------------------- retrieval
  const labels = c => ({ faq: c.expected_source_ids.filter(isFaq), passage: c.expected_source_ids.filter(id => !isFaq(id)) });
  const rankRows = (variant, kind) => ok
    .filter(({ c }) => labels(c)[kind].length)
    .map(({ r, c }) => ({ relevant: labels(c)[kind], retrieved: r.offline.retrieval[variant][kind === 'faq' ? 'faqIds' : 'sourceIds'] }));
  // "Context" = what the answer model actually receives: top 3 FAQs + top 3 passages.
  const contextHit = (retrieval, c) => [...retrieval.faqIds.slice(0, 3), ...retrieval.sourceIds.slice(0, 3)].some(id => c.expected_source_ids.includes(id));
  const withLabels = ok.filter(({ c }) => c.expected_source_ids.length);
  const emptyCases = ok.filter(({ c }) => c.retrieval_should_be_empty);
  const contextEmpty = retrieval => retrieval.faqIds.slice(0, 3).length === 0 && retrieval.sourceIds.slice(0, 3).length === 0;

  metrics.retrieval = {
    definition: 'BM25 as the pipeline runs it. goldIntent = scoped by the labeled intent (isolates retrieval from routing); ungated = no intent scoping. hitAt[k] = share of queries with ≥1 labeled source in the top k ("Recall@k" in most RAG evals); recallAt[k] = mean share of labeled sources found; contextHitRate = ≥1 labeled source in what the model receives (top 3 FAQs + top 3 passages).',
    passages: { goldIntent: rankingMetrics(rankRows('goldIntent', 'passage')), ungated: rankingMetrics(rankRows('ungated', 'passage')) },
    faqs: { goldIntent: rankingMetrics(rankRows('goldIntent', 'faq')), ungated: rankingMetrics(rankRows('ungated', 'faq')) },
    context: {
      n: withLabels.length,
      goldIntentHitRate: round(ratio(withLabels.filter(({ r, c }) => contextHit(r.offline.retrieval.goldIntent, c)).length, withLabels.length)),
      ungatedHitRate: round(ratio(withLabels.filter(({ r, c }) => contextHit(r.offline.retrieval.ungated, c)).length, withLabels.length))
    },
    emptyWhenNothingRelevant: { n: emptyCases.length, rate: round(ratio(emptyCases.filter(({ r }) => contextEmpty(r.offline.retrieval.goldIntent)).length, emptyCases.length)) },
    byCategory: Object.fromEntries(Object.entries(groupBy(withLabels, ({ c }) => c.category)).map(([k, rows]) => [k, { n: rows.length, contextHitRate: round(ratio(rows.filter(({ r, c }) => contextHit(r.offline.retrieval.goldIntent, c)).length, rows.length)) }])),
    latencyMs: latencySummary(ok.map(({ r }) => r.offline.retrieval.goldIntent.ms))
  };
  if (hasRouter) {
    const e2e = r => (mode === 'router' ? r.live.retrievalEndToEnd : r.live.retrieved);
    metrics.retrieval.context.endToEndHitRate = round(ratio(withLabels.filter(({ r, c }) => contextHit(e2e(r), c)).length, withLabels.length));
  }
  failures.retrieval = withLabels.filter(({ r, c }) => !contextHit(r.offline.retrieval.goldIntent, c)).map(({ r, c }) => {
    const g = r.offline.retrieval.goldIntent;
    const gated = labels(c).passage.length && !g.sourceIds.length && !['housing', 'rent_money', null].includes(c.expected_intent);
    return {
      id: c.id, category: c.category, input: c.query,
      expected: c.expected_source_ids.join(', '),
      actual: `faqs [${g.faqIds.slice(0, 3).join(', ')}] passages [${g.sourceIds.slice(0, 3).map((id, i) => `${id} (${g.sourceScores[i]})`).join(', ')}]`,
      why: gated ? `official passages are only searched for housing/rent_money intents; labeled intent is ${c.expected_intent}`
        : !g.faqIds.length && !g.sourceIds.length ? 'nothing scored above the minimum BM25 score'
          : 'relevant source ranked below the top 3 or not at all'
    };
  });
  failures.retrievalFalseMatches = emptyCases.filter(({ r }) => !contextEmpty(r.offline.retrieval.goldIntent)).map(({ r, c }) => ({
    id: c.id, category: c.category, input: c.query, expected: 'no source (not covered by the knowledge base)',
    actual: `faqs [${r.offline.retrieval.goldIntent.faqIds.slice(0, 3).join(', ')}] passages [${r.offline.retrieval.goldIntent.sourceIds.slice(0, 3).join(', ')}]`,
    why: 'an unrelated source scored above the minimum and would be given to the model as context'
  }));
  headline.push(`retrieval (labeled intent): passage Hit@1/3/5 ${['1', '3', '5'].map(k => pct(metrics.retrieval.passages.goldIntent.hitAt[k])).join('/')}, MRR ${metrics.retrieval.passages.goldIntent.mrr} (n=${metrics.retrieval.passages.goldIntent.n}); FAQ Hit@3 ${pct(metrics.retrieval.faqs.goldIntent.hitAt[3])} (n=${metrics.retrieval.faqs.goldIntent.n}); context hit ${pct(metrics.retrieval.context.goldIntentHitRate)}`);

  // ----------------------------------------------------------------- safety
  const escLabeled = ok.filter(({ c }) => c.should_escalate !== null);
  const hardNegatives = ok.filter(({ c }) => c.category === 'safety_hard_negative');
  const crisisLabeled = ok.filter(({ c }) => c.expected_crisis);
  const crisisOk = (c, id) => id === c.expected_crisis || c.acceptable_crisis.includes(id);
  metrics.safety = {
    definition: 'Positive = the message must reach a person (should_escalate=true: crises and housing emergencies). rules = the model-free crisis detector alone (what still works in an outage). The router/pipeline rows are the whole system.',
    rules: {
      ...binaryMetrics(escLabeled.map(({ r, c }) => ({ expected: c.should_escalate, predicted: r.offline.rules.escalates }))),
      hardNegativeFalsePositiveRate: round(ratio(hardNegatives.filter(({ r }) => r.offline.rules.escalates).length, hardNegatives.length)),
      hardNegatives: hardNegatives.length,
      crisisCategoryAccuracy: round(ratio(crisisLabeled.filter(({ r, c }) => crisisOk(c, r.offline.rules.crisis)).length, crisisLabeled.length)),
      recallByCrisisType: Object.fromEntries(Object.entries(groupBy(crisisLabeled, ({ c }) => c.expected_crisis)).map(([k, rows]) => [k, { n: rows.length, recall: round(ratio(rows.filter(({ r }) => r.offline.rules.escalates).length, rows.length)) }]))
    }
  };
  const ruleFailures = escLabeled.filter(({ r, c }) => r.offline.rules.escalates !== c.should_escalate);
  failures.safetyRules = ruleFailures.map(({ r, c }) => ({
    id: c.id, category: c.category, input: c.query,
    type: c.should_escalate ? 'FALSE NEGATIVE' : 'false positive',
    expected: c.should_escalate ? `escalate (${c.expected_crisis})` : 'no escalation',
    actual: r.offline.rules.escalates ? `escalated: ${r.offline.rules.crisis} on "${r.offline.rules.crisisMatch}"` : 'no crisis pattern matched',
    why: c.should_escalate ? 'no rule matches this phrasing; only the LLM router can catch it' : `pattern "${r.offline.rules.crisisMatch}" matched a benign use`
  }));
  headline.push(`safety rules: escalation recall ${pct(metrics.safety.rules.recall)}, precision ${pct(metrics.safety.rules.precision)}, FPR ${pct(metrics.safety.rules.falsePositiveRate)} (hard negatives ${pct(metrics.safety.rules.hardNegativeFalsePositiveRate)}) over ${escLabeled.length} labeled cases`);

  if (hasRouter) {
    const systemEsc = r => (mode === 'router' ? r.live.systemEscalates : r.live.escalated);
    metrics.safety.system = {
      scope: mode === 'router' ? 'router + rules (the action agent is not run in router mode)' : 'full pipeline (router + rules + action agent + critic)',
      ...binaryMetrics(escLabeled.map(({ r, c }) => ({ expected: c.should_escalate, predicted: systemEsc(r) }))),
      hardNegativeFalsePositiveRate: round(ratio(hardNegatives.filter(({ r }) => systemEsc(r)).length, hardNegatives.length))
    };
    failures.safetySystem = escLabeled.filter(({ r, c }) => systemEsc(r) !== c.should_escalate).map(({ r, c }) => ({
      id: c.id, category: c.category, input: c.query,
      type: c.should_escalate ? 'FALSE NEGATIVE' : 'false positive',
      expected: c.should_escalate ? `escalate (${c.expected_crisis})` : 'no escalation',
      actual: `${systemEsc(r) ? 'escalated' : 'not escalated'}; router said ${mode === 'router' ? r.live.router.intent : r.live.routerIntent}, rules said ${r.offline.rules.crisis || 'nothing'}`,
      why: c.should_escalate ? 'neither the router nor the rules flagged it' : (r.offline.rules.escalates ? 'rule false positive' : 'router or action agent escalated a benign message')
    }));
    headline.push(`safety system (${mode}): escalation recall ${pct(metrics.safety.system.recall)}, precision ${pct(metrics.safety.system.precision)}, FPR ${pct(metrics.safety.system.falsePositiveRate)}`);
  }

  // ------------------------------------------------------------------ tools
  if (mode === 'pipeline') {
    const labeled = ok.filter(({ c }) => c.expected_actions !== null);
    const agentCallsAll = ok.flatMap(({ r }) => r.live.agentTools);
    const callProblems = ok.map(x => ({ ...x, problems: classifyToolCalls(x.r.live.llm, x.r.live.agentTools) }));
    const callQuality = summarizeToolCalls(callProblems.map(x => x.problems));
    const systemTools = r => new Set([...toolsCalled(r), ...r.live.criticTools]);
    const checkViolations = ({ r, c }) => {
      const v = [];
      const tc = c.tool_checks;
      if (!tc) return v;
      if (tc.max_tickets !== undefined && r.live.ticketsCreated > tc.max_tickets) v.push(`${r.live.ticketsCreated} tickets created (max ${tc.max_tickets})`);
      for (const p of tc.forbid_priority || []) if (r.live.agentTools.some(t => t.priority === p)) v.push(`ticket priority "${p}"`);
      if (tc.forbid_arg_pattern && r.live.agentTools.some(t => new RegExp(tc.forbid_arg_pattern, 'i').test(JSON.stringify(t.args)))) v.push(`tool arguments matched /${tc.forbid_arg_pattern}/`);
      return v;
    };
    const withChecks = ok.filter(({ c }) => c.tool_checks);
    metrics.tools = {
      definition: 'Agent = tool calls the action agent itself chose; system = including tickets the critic forced. expected "none" = no tool call; a tool name = that tool must be among the calls.',
      n: labeled.length,
      agentSelectionAccuracy: round(ratio(labeled.filter(({ r, c }) => toolOk(primaryTool(c.expected_actions), toolsCalled(r))).length, labeled.length)),
      systemSelectionAccuracy: round(ratio(labeled.filter(({ r, c }) => toolOk(primaryTool(c.expected_actions), systemTools(r))).length, labeled.length)),
      actDecision: binaryMetrics(labeled.map(({ r, c }) => ({ expected: c.expected_actions.ticket !== 'none', predicted: toolsCalled(r).size > 0 }))),
      toolCalls: agentCallsAll.length,
      executionSuccessRate: round(ratio(agentCallsAll.filter(t => !t.error).length, agentCallsAll.length)),
      callQuality,
      invalidCallRate: callQuality.invalidCallRate,
      actionAgentRuns: ok.filter(({ r }) => r.live.actionAgentRan).length,
      guardrailChecks: { n: withChecks.length, violations: withChecks.filter(x => checkViolations(x).length).length }
    };
    failures.tools = labeled.filter(({ r, c }) => !toolOk(primaryTool(c.expected_actions), toolsCalled(r))).map(({ r, c }) => ({
      id: c.id, category: c.category, input: c.query, expected: primaryTool(c.expected_actions),
      actual: `${[...toolsCalled(r)].join(', ') || 'no tool calls'}${r.live.criticTools.length ? ` (critic added: ${r.live.criticTools.join(', ')})` : ''}${r.live.actionAgentRan ? '' : ' — action agent did not run'}`,
      why: !r.live.actionAgentRan ? `action agent skipped (intent ${r.live.intent}, router incident=${r.live.routerIncident})` : c.expected_actions.ticket === 'none' ? 'agent acted on a message that needed no action' : 'agent did not call the expected tool'
    }));
    failures.toolGuardrails = withChecks.filter(x => checkViolations(x).length).map(x => ({ id: x.c.id, category: x.c.category, input: x.c.query, expected: JSON.stringify(x.c.tool_checks), actual: checkViolations(x).join('; '), why: 'model-controlled arguments got past validation' }));
    headline.push(`tools: agent selection ${pct(metrics.tools.agentSelectionAccuracy)}, system ${pct(metrics.tools.systemSelectionAccuracy)} (n=${labeled.length}); execution success ${pct(metrics.tools.executionSuccessRate)} of ${agentCallsAll.length} calls; invalid calls ${callQuality.counts.hallucinated + callQuality.counts.malformedArguments + callQuality.counts.providerRejected}/${callQuality.attemptedCalls} (hallucinated ${callQuality.counts.hallucinated}, malformed args ${callQuality.counts.malformedArguments}, provider-rejected ${callQuality.counts.providerRejected}); server-rejected ${callQuality.counts.serverRejected}`);
    failures.toolCalls = toolCallFailures(callProblems);

    // ---------------------------------------------------------------- answers
    const answered = ok.filter(({ r }) => typeof r.live.answer === 'string');
    const withSources = answered.filter(({ r }) => r.live.citations.length);
    const checks = ok.filter(({ c }) => c.answer_checks?.must_not_match?.length);
    const violations = ({ r, c }) => (c.answer_checks?.must_not_match || []).filter(p => new RegExp(p, 'i').test(r.live.answer));
    const flagged = answered.filter(({ r }) => r.live.fabrication?.unsupported.length);
    metrics.answers = {
      n: answered.length,
      citedWhenSourcesGiven: { n: withSources.length, rate: round(ratio(withSources.filter(({ r }) => r.live.citations.some(x => x.cited)).length, withSources.length)) },
      answerChecks: { n: checks.length, violations: checks.filter(x => violations(x).length).length },
      unsupportedSpecifics: { n: answered.length, answersFlagged: flagged.length, rate: round(ratio(flagged.length, answered.length)), note: 'heuristic: phone numbers, emails, domains, %, $ and form numbers not found in the knowledge base or the student message; review each flag' },
      grounding: groundingMetrics(answered)
    };
    failures.grounding = answered.filter(({ r }) => {
      const g = r.live.groundedness;
      return g && (g.invalidMarkers.length || g.contextUnsupported.length || g.policyClaimWithoutContext || g.citesLabeledSource === false);
    }).map(({ r, c }) => {
      const g = r.live.groundedness;
      const why = [
        g.invalidMarkers.length ? `cites [${g.invalidMarkers.join('], [')}] but only ${(r.live.retrieved?.sourceIds || []).length} passages were given` : null,
        g.contextUnsupported.length ? `specifics not in its context: ${g.contextUnsupported.map(u => u.value).join(', ')}` : null,
        g.policyClaimWithoutContext ? 'claims university policy with no policy text in its context' : null,
        g.citesLabeledSource === false ? `a labeled passage was given but it cited ${g.citedIds.join(', ') || 'nothing'}` : null
      ].filter(Boolean).join('; ');
      return { id: c.id, category: c.category, input: c.query, expected: 'grounded in the context given', actual: r.live.answer.slice(0, 200), why };
    });
    failures.answerChecks = checks.filter(x => violations(x).length).map(x => ({ id: x.c.id, category: x.c.category, input: x.c.query, expected: `must not match ${JSON.stringify(x.c.answer_checks.must_not_match)}`, actual: violations(x).join(', '), why: 'answer contains forbidden content', answer: x.r.live.answer.slice(0, 600) }));
    failures.unsupportedSpecifics = flagged.map(({ r, c }) => ({ id: c.id, category: c.category, input: c.query, expected: 'only specifics present in the knowledge base', actual: r.live.fabrication.unsupported.map(u => `${u.type}: ${u.value}`).join(', '), why: 'possible fabrication (heuristic)' }));
  }

  // ------------------------------------------------------------ agent tools
  if (mode === 'agent') Object.assign(metrics, agentMetrics(ok, failures, headline));

  // ------------------------------------------------------------ reliability
  if (live) {
    const calls = all.flatMap(({ r }) => r.live?.llm || []);
    const routerCalls = calls.filter(c => c.stage === 'router');
    metrics.reliability = {
      casesRun: all.length,
      casesErrored: all.filter(({ r }) => r.error).length,
      errorRate: round(ratio(all.filter(({ r }) => r.error).length, all.length)),
      casesRetried: all.filter(({ r }) => r.attempts > 1).length,
      llmCalls: calls.length,
      llmCallErrors: calls.filter(c => c.error).length,
      llmOutputRejected: calls.filter(c => c.error?.status === 400).length,
      rateLimited: calls.filter(c => c.error?.status === 429).length,
      routerMalformedOutputs: routerCalls.filter(c => c.malformed.length).length,
      routerMalformedRate: round(ratio(routerCalls.filter(c => c.malformed.length).length, routerCalls.length)),
      ...(mode === 'pipeline' ? {
        successfulResponseRate: round(ratio(ok.filter(({ r }) => r.live.answer && !r.live.groqFailed).length, all.length)),
        fallbackAnswers: ok.filter(({ r }) => r.live.groqFailed).length
      } : {})
    };
    failures.errors = all.filter(({ r }) => r.error).map(({ r, c }) => ({ id: c.id, category: c.category, input: c.query, expected: 'a completed run', actual: `${r.error.kind} after ${r.attempts} attempt(s)`, why: r.error.message }));
    headline.push(`reliability: ${metrics.reliability.casesErrored}/${all.length} cases errored after retries; ${metrics.reliability.llmCallErrors} failed model calls of ${calls.length}; router malformed outputs ${metrics.reliability.routerMalformedOutputs}/${routerCalls.length}`);

    // ------------------------------------------------------ latency & tokens
    const stageCalls = stage => calls.filter(c => c.stage === stage && !c.error);
    const stages = ['router', 'answer', 'action'];
    metrics.latencyMs = {
      llmByStage: Object.fromEntries(stages.map(s => [s, latencySummary(stageCalls(s).map(c => c.ms))]).filter(([, v]) => v.n)),
      retrieval: metrics.retrieval.latencyMs,
      ...(mode === 'pipeline' ? {
        endToEnd: latencySummary(ok.map(({ r }) => r.live.totalMs)),
        pipelineStages: Object.fromEntries(['router', 'critic_pre', 'retrieval', 'action', 'critic'].map(s => [s, latencySummary(ok.map(({ r }) => r.live.stages[s]))]).filter(([, v]) => v.n))
      } : {})
    };
    const withUsage = calls.filter(c => c.usage);
    const perStage = Object.fromEntries(stages.map(s => {
      const xs = withUsage.filter(c => c.stage === s);
      return [s, { calls: xs.length, avgInput: round(ratio(xs.reduce((n, c) => n + c.usage.input, 0), xs.length), 1), avgOutput: round(ratio(xs.reduce((n, c) => n + c.usage.output, 0), xs.length), 1) }];
    }).filter(([, v]) => v.calls));
    const caseTotals = ok.map(({ r }) => (r.live.llm || []).reduce((acc, c) => ({ input: acc.input + (c.usage?.input || 0), output: acc.output + (c.usage?.output || 0) }), { input: 0, output: 0 }));
    const avgIn = ratio(caseTotals.reduce((n, t) => n + t.input, 0), caseTotals.length);
    const avgOut = ratio(caseTotals.reduce((n, t) => n + t.output, 0), caseTotals.length);
    metrics.tokens = {
      callsWithUsage: withUsage.length,
      callsWithoutUsage: calls.length - withUsage.length,
      perStage,
      perCase: { avgInput: round(avgIn, 1), avgOutput: round(avgOut, 1) },
      totalInput: withUsage.reduce((n, c) => n + c.usage.input, 0),
      totalOutput: withUsage.reduce((n, c) => n + c.usage.output, 0),
      estimatedCostPerCaseUSD: meta.pricing && avgIn !== null ? round((avgIn * meta.pricing.inputPerM + avgOut * meta.pricing.outputPerM) / 1e6, 6) : null
    };
  } else {
    metrics.latencyMs = { retrieval: metrics.retrieval.latencyMs, crisisRules: latencySummary(ok.map(({ r }) => r.offline.rules.ms)) };
  }

  // ------------------------------------------------------- worst categories
  const categoryScores = [];
  for (const [category, rows] of Object.entries(groupBy(ok, ({ c }) => c.category))) {
    const scores = {};
    const ret = metrics.retrieval.byCategory[category];
    if (ret && ret.n >= 3) scores.retrievalContextHit = ret.contextHitRate;
    if (metrics.routing?.byCategory[category]?.n >= 3) scores.routingAccuracy = metrics.routing.byCategory[category].accuracy;
    const esc = rows.filter(({ c }) => c.should_escalate !== null);
    if (esc.length >= 3) scores.safetyRulesAccuracy = round(ratio(esc.filter(({ r, c }) => r.offline.rules.escalates === c.should_escalate).length, esc.length));
    const values = Object.values(scores).filter(v => v !== null);
    if (values.length) categoryScores.push({ category, n: rows.length, worst: Math.min(...values), scores });
  }
  metrics.worstCategories = categoryScores.sort((a, b) => a.worst - b.worst).slice(0, 6);

  const cases = records.map(r => ({ ...r, logs: r.logs?.length ? r.logs : undefined }));
  return { meta, headline, metrics, failures, cases };
}

module.exports = { summarize, intentOk, toolOk };
