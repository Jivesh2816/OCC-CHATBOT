const path = require('path');
const fs = require('fs');

// Eval runner. Every suite calls the real, running backend over HTTP (not a
// reimplementation of its logic), so it measures what users actually get.
//
//   chat   eval-set.json   router intent, critic flags, citations, memory, escalation
//   lease  lease-set.json  per-rule precision / recall, rules-only vs rules+model
//   scam   scam-set.json   risk-level accuracy
//
// Usage: node eval/run-eval.js [chat|lease|scam ...]   (default: all)
// Anything the model decides non-deterministically (exact wording, which
// tools the action agent calls) is logged for review rather than asserted.

const BASE_URL = process.env.EVAL_BASE_URL || 'http://localhost:5000';
// Defaults stay under the server's default per-IP rate limits (12 chats/min,
// 5 checks/min). Lower them only against a server started with higher limits.
const CHAT_DELAY_MS = Number(process.env.EVAL_CHAT_DELAY_MS ?? 5500);
const TOOL_DELAY_MS = Number(process.env.EVAL_TOOL_DELAY_MS ?? 12500);
// Sessions carry multi-turn memory, so each run gets fresh session ids —
// otherwise a case would see its own answer from the previous run as context.
const RUN_ID = Date.now().toString(36);
const RESULTS_PATH = path.join(__dirname, 'eval-results.json');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const load = file => JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');

async function post(route, body) {
  const res = await fetch(`${BASE_URL}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${route}`);
  return res.json();
}

// ---------------------------------------------------------------- chat ----

function checkCriticFlags(expectedFlags, actualFlags) {
  const mismatches = [];
  for (const [key, expectedValue] of Object.entries(expectedFlags || {})) {
    if (expectedValue === null) continue; // not checked
    if (actualFlags?.[key] !== expectedValue) {
      mismatches.push(`criticFlags.${key}: expected ${expectedValue}, got ${actualFlags?.[key]}`);
    }
  }
  return mismatches;
}

async function runChatCase(testCase) {
  const { id, message, expected = {}, setup = [] } = testCase;
  const sessionId = `eval-${id}-${RUN_ID}`;

  // Earlier turns for memory cases, sent in the same session first.
  for (const turn of setup) {
    await post('/chat', { message: turn, sessionId });
    await sleep(CHAT_DELAY_MS);
  }

  const data = await post('/chat', { message, sessionId });
  const mismatches = [];
  const citations = data.citations || [];
  const cited = citations.filter(c => c.cited);

  if (expected.intent !== undefined && data.intent !== expected.intent) {
    mismatches.push(`intent: expected "${expected.intent}", got "${data.intent}"`);
  }
  if (expected.matchType !== undefined && data.matchType !== expected.matchType) {
    mismatches.push(`matchType: expected "${expected.matchType}", got "${data.matchType}"`);
  }
  mismatches.push(...checkCriticFlags(expected.criticFlags, data.criticFlags));

  if (expected.citesSource && cited.length === 0) {
    mismatches.push(`citesSource: answer cited none of ${citations.length} retrieved passages`);
  }
  if (expected.sourceAnyOf && !citations.some(c => expected.sourceAnyOf.includes(c.id))) {
    mismatches.push(`sourceAnyOf: retrieved [${citations.map(c => c.id).join(', ')}], wanted one of [${expected.sourceAnyOf.join(', ')}]`);
  }
  if (expected.noOfficialSources && citations.length > 0) {
    mismatches.push(`noOfficialSources: retrieved [${citations.map(c => c.id).join(', ')}]`);
  }
  if (expected.escalatedTicket) {
    const escalated = (data.actions || []).some(a => a.tool === 'escalate_ticket' && !a.result?.error);
    if (!escalated) mismatches.push('escalatedTicket: no escalated ticket was produced');
  }

  return {
    id,
    message,
    pass: mismatches.length === 0,
    mismatches,
    actual: {
      intent: data.intent,
      routerConfidence: data.routerConfidence,
      matchType: data.matchType,
      criticFlags: data.criticFlags,
      citations: citations.map(c => `${c.id}${c.cited ? ' (cited)' : ''}`),
      memoryTurns: data.memoryTurns,
      actionsTaken: (data.actions || []).map(a => `${a.tool}${a.forcedByCritic ? ' [critic]' : ''}`)
    }
  };
}

async function runChatSuite() {
  const cases = load('eval-set.json');
  console.log(`\n=== chat: ${cases.length} cases ===`);
  const results = [];
  for (const testCase of cases) {
    let result;
    try {
      result = await runChatCase(testCase);
    } catch (error) {
      result = { id: testCase.id, message: testCase.message, pass: false, mismatches: [error.message], actual: null };
    }
    results.push(result);
    console.log(`[${result.pass ? 'PASS' : 'FAIL'}] ${result.id} — "${result.message}"`);
    if (!result.pass) result.mismatches.forEach(m => console.log(`         ${m}`));
    await sleep(CHAT_DELAY_MS);
  }

  const withExpectation = key => cases.map((c, i) => [c, results[i]]).filter(([c]) => c.expected?.[key] !== undefined);
  const metric = (key, ok) => {
    const rows = withExpectation(key);
    const passed = rows.filter(([c, r]) => r.actual && ok(c, r)).length;
    return `${passed}/${rows.length}`;
  };

  const summary = {
    total: results.length,
    passed: results.filter(r => r.pass).length,
    intentAccuracy: metric('intent', (c, r) => r.actual.intent === c.expected.intent),
    citedOfficialSource: metric('citesSource', (c, r) => r.actual.citations.some(x => x.endsWith('(cited)'))),
    retrievedExpectedSource: metric('sourceAnyOf', (c, r) => r.actual.citations.some(x => c.expected.sourceAnyOf.includes(x.split(' ')[0]))),
    memoryFollowUps: `${cases.map((c, i) => [c, results[i]]).filter(([c, r]) => c.setup && r.pass).length}/${cases.filter(c => c.setup).length}`,
    urgentEscalated: metric('escalatedTicket', (c, r) => r.actual.actionsTaken.some(a => a.startsWith('escalate_ticket')))
  };
  return { summary, results };
}

// --------------------------------------------------------------- lease ----

async function runLeaseSuite() {
  const cases = load('lease-set.json');
  console.log(`\n=== lease: ${cases.length} cases ===`);
  const results = [];
  // Counted per (case, rule): expected rules are positives; forbidden rules
  // and anything flagged that wasn't expected are the false positives.
  const tally = { combined: { tp: 0, fp: 0, fn: 0 }, rulesOnly: { tp: 0, fp: 0, fn: 0 } };

  for (const testCase of cases) {
    let result;
    try {
      const data = await post('/lease/check', { text: testCase.text });
      const flagged = new Set(data.findings.map(f => f.ruleId));
      const flaggedByRules = new Set(data.findings.filter(f => f.detectedBy.includes('rules')).map(f => f.ruleId));
      const severity = Object.fromEntries(data.findings.map(f => [f.ruleId, f.severity]));
      const expect = new Set(testCase.expect);
      // Any unexpected "void" flag is a false positive. Softer "check" notes
      // (deposit amount, shared kitchen…) only count when the case forbids them.
      const counts = f => !expect.has(f) && (severity[f] === 'void' || (testCase.forbid || []).includes(f));

      for (const [name, set] of [['combined', flagged], ['rulesOnly', flaggedByRules]]) {
        for (const rule of expect) set.has(rule) ? tally[name].tp++ : tally[name].fn++;
        for (const rule of set) if (counts(rule)) tally[name].fp++;
      }

      const missing = [...expect].filter(r => !flagged.has(r));
      const wrong = [...flagged].filter(counts);
      result = {
        id: testCase.id,
        pass: missing.length === 0 && wrong.length === 0,
        mismatches: [...missing.map(r => `missed ${r}`), ...wrong.map(r => `wrongly flagged ${r}`)],
        actual: data.findings.map(f => `${f.ruleId} [${f.detectedBy.join('+')}]`),
        modelError: data.summary.modelError
      };
    } catch (error) {
      result = { id: testCase.id, pass: false, mismatches: [error.message], actual: null };
    }
    results.push(result);
    console.log(`[${result.pass ? 'PASS' : 'FAIL'}] ${result.id}  ${result.actual ? result.actual.join(', ') || '(nothing flagged)' : ''}`);
    if (!result.pass) result.mismatches.forEach(m => console.log(`         ${m}`));
    if (result.modelError) console.log(`         model error: ${result.modelError}`);
    await sleep(TOOL_DELAY_MS);
  }

  const score = t => ({ precision: pct(t.tp, t.tp + t.fp), recall: pct(t.tp, t.tp + t.fn), ...t });
  return {
    summary: {
      total: results.length,
      passed: results.filter(r => r.pass).length,
      rulesPlusModel: score(tally.combined),
      rulesOnly: score(tally.rulesOnly)
    },
    results
  };
}

// ---------------------------------------------------------------- scam ----

async function runScamSuite() {
  const cases = load('scam-set.json');
  console.log(`\n=== scam: ${cases.length} cases ===`);
  const results = [];
  for (const testCase of cases) {
    let result;
    try {
      const data = await post('/listing/check', { text: testCase.text });
      result = {
        id: testCase.id,
        expected: testCase.expect,
        actual: data.risk.level,
        pass: data.risk.level === testCase.expect,
        signals: data.signals.map(s => `${s.id} [${s.detectedBy.join('+')}]`)
      };
    } catch (error) {
      result = { id: testCase.id, expected: testCase.expect, actual: null, pass: false, error: error.message };
    }
    results.push(result);
    console.log(`[${result.pass ? 'PASS' : 'FAIL'}] ${result.id}  expected ${result.expected}, got ${result.actual}  ${(result.signals || []).join(', ')}`);
    await sleep(TOOL_DELAY_MS);
  }

  const scams = results.filter(r => r.expected !== 'low');
  const legit = results.filter(r => r.expected === 'low');
  return {
    summary: {
      total: results.length,
      levelAccuracy: `${results.filter(r => r.pass).length}/${results.length}`,
      scamsFlagged: `${scams.filter(r => r.actual && r.actual !== 'low').length}/${scams.length}`,
      legitimateMarkedLow: `${legit.filter(r => r.actual === 'low').length}/${legit.length}`
    },
    results
  };
}

// ---------------------------------------------------------------- main ----

const SUITES = { chat: runChatSuite, lease: runLeaseSuite, scam: runScamSuite };

async function main() {
  const requested = process.argv.slice(2).filter(a => SUITES[a]);
  const suites = requested.length ? requested : Object.keys(SUITES);
  console.log(`Running ${suites.join(', ')} against ${BASE_URL}`);

  const output = { runAt: new Date().toISOString(), baseUrl: BASE_URL, suites: {} };
  for (const name of suites) output.suites[name] = await SUITES[name]();

  console.log('\n--- Summary ---');
  for (const [name, { summary }] of Object.entries(output.suites)) {
    console.log(`${name}: ${JSON.stringify(summary)}`);
  }

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2));
  console.log(`\nFull results written to ${RESULTS_PATH}`);
  const failed = Object.values(output.suites).some(s => s.results.some(r => !r.pass));
  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error('Eval run failed:', error.message);
  process.exit(1);
});
