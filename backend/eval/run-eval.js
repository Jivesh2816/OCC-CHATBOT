const path = require('path');
const fs = require('fs');

// Stage 6: runs the eval set through the real, running /chat pipeline (not a
// reimplementation of the logic) and checks two things per the project plan:
// did the router pick the right intent, and did the critic correctly flag
// the cases that should be flagged. Anything the LLM's own judgment decides
// non-deterministically (exact generated wording, which tools the action
// agent calls) is logged for manual review instead of hard-asserted.
const BASE_URL = process.env.EVAL_BASE_URL || 'http://localhost:5000';
const DELAY_MS = 300; // be polite to Groq's rate limits between cases

const EVAL_SET_PATH = path.join(__dirname, 'eval-set.json');
const RESULTS_PATH = path.join(__dirname, 'eval-results.json');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

async function runCase(testCase) {
  const { id, message, expected = {} } = testCase;
  const sessionId = `eval-${id}`;

  const res = await fetch(`${BASE_URL}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId })
  });

  if (!res.ok) {
    return { id, message, pass: false, mismatches: [`HTTP ${res.status}`], actual: null };
  }

  const data = await res.json();
  const mismatches = [];

  if (expected.intent !== undefined && data.intent !== expected.intent) {
    mismatches.push(`intent: expected "${expected.intent}", got "${data.intent}"`);
  }
  if (expected.matchType !== undefined && data.matchType !== expected.matchType) {
    mismatches.push(`matchType: expected "${expected.matchType}", got "${data.matchType}"`);
  }
  mismatches.push(...checkCriticFlags(expected.criticFlags, data.criticFlags));

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
      actionsTaken: (data.actions || []).map(a => a.tool)
    }
  };
}

async function main() {
  const evalSet = JSON.parse(fs.readFileSync(EVAL_SET_PATH, 'utf8'));
  console.log(`Running ${evalSet.length} eval cases against ${BASE_URL} ...\n`);

  const results = [];
  for (const testCase of evalSet) {
    let result;
    try {
      result = await runCase(testCase);
    } catch (error) {
      result = { id: testCase.id, message: testCase.message, pass: false, mismatches: [error.message], actual: null };
    }
    results.push(result);

    const status = result.pass ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${result.id} — "${result.message}"`);
    if (!result.pass) {
      result.mismatches.forEach(m => console.log(`         ${m}`));
    }
    if (testCase.note) {
      console.log(`         note: ${testCase.note}`);
    }

    await sleep(DELAY_MS);
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.length - passed;

  // Intent accuracy only over cases that actually assert an intent.
  const intentChecked = evalSet.filter(c => c.expected?.intent !== undefined);
  const intentCorrect = results.filter((r, i) => {
    const expected = evalSet[i].expected?.intent;
    return expected !== undefined && r.actual?.intent === expected;
  }).length;

  console.log('\n--- Summary ---');
  console.log(`Cases: ${results.length}   Passed: ${passed}   Failed: ${failed}`);
  console.log(`Router intent accuracy: ${intentCorrect}/${intentChecked.length}`);

  fs.writeFileSync(RESULTS_PATH, JSON.stringify({
    runAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    summary: { total: results.length, passed, failed, intentAccuracy: `${intentCorrect}/${intentChecked.length}` },
    results
  }, null, 2));
  console.log(`\nFull results written to ${RESULTS_PATH}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Eval run failed:', error.message);
  process.exit(1);
});
