// Classifies what went wrong with the action agent's tool calls. Four kinds,
// kept apart because they have different causes and different fixes:
//
//   hallucinated       the model called a tool that doesn't exist
//   malformedArguments the model called a real tool with arguments that are
//                      not JSON, not an object, or break the tool's JSON schema
//   providerRejected   the provider (Groq) refused the model's own generation
//                      as an unparseable tool call (HTTP 400 tool_use_failed),
//                      so the app never saw a call; the whole turn is lost
//   serverRejected     the app executed a well-formed call and its own
//                      validation refused it (unknown office, no such ticket…)
//
// Computed from what each run records (the raw model output on every action
// call, the provider's error, and each executed call's result), so it works on
// cached runs recorded before this classification existed.
const { validateToolCall } = require('./tool-schema');
const { TOOL_NAMES } = require('./dataset');

// Groq's error for a generation it could not parse as a tool call.
const PROVIDER_TOOL_REJECTION = /tool_use_failed|failed to parse tool call/i;

const isProviderRejected = call => call.stage === 'action' && call.error?.status === 400 && PROVIDER_TOOL_REJECTION.test(call.error.message || '');

// The tool the rejected generation was trying to call, when the error echoes it.
function rejectedToolName(call) {
  const match = /\\?"name\\?"\s*:\s*\\?"([a-z_]+)/i.exec(call.error?.message || '');
  return match ? match[1] : null;
}

// llmCalls: the case's recorded model calls; executed: the calls the app ran,
// each { tool, error }. Returns per-kind lists for one case.
function classifyToolCalls(llmCalls, executed) {
  const actionCalls = (llmCalls || []).filter(call => call.stage === 'action');
  const raw = actionCalls.flatMap(call => call.toolCalls || []);
  const out = { actionTurns: actionCalls.length, rawToolCalls: raw.length, executed: (executed || []).length, hallucinated: [], malformedArguments: [], providerRejected: [], serverRejected: [] };
  for (const tc of raw) {
    if (!TOOL_NAMES.includes(tc.name)) { out.hallucinated.push({ tool: String(tc.name), why: 'tool does not exist' }); continue; }
    const problems = validateToolCall(tc.name, tc.arguments);
    if (problems.length) out.malformedArguments.push({ tool: tc.name, why: problems.join('; ') });
  }
  for (const call of actionCalls.filter(isProviderRejected)) {
    out.providerRejected.push({ tool: rejectedToolName(call), why: 'provider rejected the generation as an unparseable tool call (400)' });
  }
  // A hallucinated tool also comes back as an "Unknown tool" error; it is counted above, once.
  for (const t of executed || []) {
    if (t.error && TOOL_NAMES.includes(t.tool)) out.serverRejected.push({ tool: t.tool, why: String(t.error) });
  }
  return out;
}

// Rates over a set of cases. Denominators: hallucinated and malformed are over
// raw tool calls the model produced; provider rejections over action turns
// (each rejected turn is one attempted call the app never received); server
// rejections over executed calls. invalidCallRate combines the three
// model-side kinds over every attempted call (raw calls + rejected turns).
function summarizeToolCalls(perCase) {
  const sum = key => perCase.reduce((n, x) => n + (Array.isArray(x[key]) ? x[key].length : x[key]), 0);
  const raw = sum('rawToolCalls');
  const turns = sum('actionTurns');
  const executed = sum('executed');
  const [h, m, p, s] = ['hallucinated', 'malformedArguments', 'providerRejected', 'serverRejected'].map(sum);
  const rate = (a, b) => (b ? Math.round((a / b) * 10000) / 10000 : null);
  return {
    actionTurns: turns,
    rawToolCalls: raw,
    attemptedCalls: raw + p,
    executedCalls: executed,
    counts: { hallucinated: h, malformedArguments: m, providerRejected: p, serverRejected: s },
    hallucinatedToolRate: rate(h, raw),
    malformedArgumentRate: rate(m, raw),
    providerRejectedRate: rate(p, turns),
    serverRejectedRate: rate(s, executed),
    invalidCallRate: rate(h + m + p, raw + p)
  };
}

module.exports = { classifyToolCalls, summarizeToolCalls, isProviderRejected };
