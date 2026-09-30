#!/usr/bin/env node
// Eval harness for the chat pipeline. Runs the real code in-process, against
// an in-memory database, with staff alerts disabled and outbound network
// limited to the Groq API, so nothing a run does reaches a person or a
// production store.
//
//   node eval/run.js --mode offline    deterministic, no API key: retrieval (given
//                                      the labeled intent) and the rule-based safety layer
//   node eval/run.js --mode router     + one router call per case: routing metrics,
//                                      end-to-end retrieval and escalation given the router
//   node eval/run.js --mode agent      the action agent alone, given the labeled intent:
//                                      tool selection, argument validity, loop bounds
//   node eval/run.js --mode pipeline   the full runPipeline() per case: answers, tool
//                                      calls, critic, latency, tokens (costs the most quota)
//
//   --resume        reuse cached live results (eval/cache/<mode>.jsonl) that are still
//                   valid for the current model, prompts and code; run only the rest
//   --allow-stale   with --resume, also reuse cached results whose fingerprint changed
//                   (reported as stale)
//   --cached-only   report on valid cached cases only; skip the rest (no API calls)
//
//   node eval/run.js --mode router --replay <eval-results.json>
//                                      re-score stored router outputs against the current
//                                      deterministic code (rules, retrieval); no API calls
//
// Options: --split dev|heldout  --category a,b  --ids x,y  --limit N  --label name  --out dir  --verbose
// Output:  eval/results/<mode>[-<label>]/eval-results.json and eval-report.md
// Details: eval/README.md
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');

// --- Isolation, before any app module loads --------------------------------
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.SQLITE_PATH = ':memory:';
for (const key of ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'STAFF_ALERT_WEBHOOK_URL', 'SMTP_URL', 'STAFF_ALERT_EMAIL']) delete process.env[key];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, ...rest) => {
  const host = new URL(typeof url === 'string' ? url : url.url).host;
  if (host !== 'api.groq.com') throw new Error(`eval: blocked outbound request to ${host}`);
  return realFetch(url, ...rest);
};

function parseArgs(argv) {
  const args = { mode: 'offline', category: null, ids: null, limit: null, label: null, out: null, verbose: false, replay: null, split: null, resume: false, allowStale: false, cachedOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--mode') args.mode = next();
    else if (a === '--category') args.category = next().split(',');
    else if (a === '--ids') args.ids = next().split(',');
    else if (a === '--limit') args.limit = Number(next());
    else if (a === '--label') args.label = next();
    else if (a === '--out') args.out = next();
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--replay') args.replay = next();
    else if (a === '--split') args.split = next();
    else if (a === '--resume') args.resume = true;
    else if (a === '--allow-stale') args.allowStale = true;
    else if (a === '--cached-only') { args.cachedOnly = true; args.resume = true; }
    else throw new Error(`Unknown argument ${a}`);
  }
  if (!['offline', 'router', 'agent', 'pipeline'].includes(args.mode)) throw new Error(`--mode must be offline, router, agent or pipeline`);
  if (args.replay && args.mode !== 'router') throw new Error('--replay only applies to --mode router');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const LIVE = args.mode !== 'offline';
// Replaying recorded router outputs needs no API access.
const CALLS_API = LIVE && !args.replay && !args.cachedOnly;
if (CALLS_API && !process.env.GROQ_API_KEY) {
  console.error(`--mode ${args.mode} calls the Groq API: set GROQ_API_KEY (backend/.env or the environment). --mode offline needs no key.`);
  process.exit(2);
}

// App logs are noisy and some include per-stage detail; keep them per case
// instead of on the terminal (--verbose prints them too).
const appLogs = [];
const originalLog = console.log;
const originalError = console.error;
const say = (...parts) => originalLog(...parts);
console.log = (...parts) => { appLogs.push(parts.map(String).join(' ')); if (args.verbose) originalLog(...parts); };
console.error = (...parts) => { appLogs.push('ERROR ' + parts.map(p => (p?.message ? p.message : String(p))).join(' ')); if (args.verbose) originalError(...parts); };
process.removeAllListeners('warning');

const { groq, MODEL } = require('../lib/llm');
const { VALID_INTENTS, ROUTER_SYSTEM_PROMPT, classifyIntent } = require('../pipeline/router');
const { retrieve } = require('../pipeline/retrieval');
const { ACTION_AGENT_INTENTS, actionAgent } = require('../pipeline/action');
const cache = require('./lib/cache');
const { validateToolCall } = require('./lib/tool-schema');
const { detectCrisis } = require('../lib/crisis');
const critic = require('../lib/critic');
const { loadDataset, TOOL_NAMES } = require('./lib/dataset');
const { instrument, isInfraError } = require('./lib/llm-recorder');
const { scanAnswer } = require('./lib/fabrication');
const { groundedness } = require('./lib/groundedness');
const { summarize } = require('./lib/summarize');
const { renderReport } = require('./lib/report');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ms = start => Number(process.hrtime.bigint() - start) / 1e6;
const historyFrom = setup => setup.map((content, i) => ({ id: i + 1, role: 'user', content, timestamp: '' }));
const ids = hits => hits.map(h => h.doc.id);

// Retrieval as the pipeline would do it for a given intent, at depth 5 so
// Hit@5 / Recall@5 can be computed. The top 3 of each list is exactly what
// production passes to the model.
function retrievalFor(c, intent, crisis = detectCrisis(c.query)) {
  const started = process.hrtime.bigint();
  const r = retrieve(c.query, intent, historyFrom(c.setup), { faqTopN: 5, sourceTopN: 5, crisis });
  return { intent, faqIds: ids(r.faqs), sourceIds: ids(r.sources), faqScores: r.faqs.map(h => +h.score.toFixed(2)), sourceScores: r.sources.map(h => +h.score.toFixed(2)), ms: ms(started) };
}

// The deterministic part of every case: what the rules decide with no model.
function offlineRecord(c) {
  const crisisStarted = process.hrtime.bigint();
  const crisis = detectCrisis(c.query);
  const crisisMs = ms(crisisStarted);
  return {
    retrieval: {
      goldIntent: retrievalFor(c, c.expected_intent),
      // The bare ranker, with no intent gating or category scoping.
      ungated: retrievalFor(c, null)
    },
    rules: {
      crisis: crisis ? crisis.id : null,
      crisisMatch: crisis ? crisis.match : null,
      // Any crisis match makes the critic open and escalate a ticket
      // (urgent → ensureTicket; housing emergency → resources + ensureTicket).
      escalates: !!crisis,
      ms: crisisMs
    }
  };
}

async function routerRecord(c, recorder, replay) {
  let result, routerMs, llm;
  if (replay) {
    const cached = replay[c.id];
    if (!cached) throw new Error(`no recorded router output for ${c.id}`);
    result = cached.router.intent === null ? null : cached.router;
    routerMs = cached.router.ms;
    llm = cached.llm;
  } else {
    recorder.calls = [];
    const started = process.hrtime.bigint();
    result = await classifyIntent(c.query, historyFrom(c.setup));
    routerMs = ms(started);
    llm = recorder.calls.slice();
  }
  const pre = critic.preCheck(c.query, result?.intent || null);
  const finalIntent = pre.intent;
  const skipsRetrieval = finalIntent === 'urgent' || finalIntent === 'out_of_scope';
  return {
    router: { intent: result?.intent ?? null, confidence: result?.confidence ?? null, incident: result?.incident ?? null, ms: routerMs },
    finalIntent,
    retrievalEndToEnd: skipsRetrieval ? { intent: finalIntent, faqIds: [], sourceIds: [], skipped: true } : retrievalFor(c, finalIntent, pre.crisis),
    // Router + rules: the critic escalates every urgent message and every
    // housing emergency. The action agent can also escalate (pipeline mode only).
    systemEscalates: finalIntent === 'urgent' || !!(pre.crisis && !pre.crisis.urgent),
    llm,
    replayed: !!replay
  };
}

// The action agent on its own, given the labeled intent (the pipeline would
// only reach it after the router), against the in-memory database. Measures
// the agent's own tool decisions; the critic's backstop isn't applied here.
async function agentRecord(c, recorder) {
  recorder.calls = [];
  const sessionId = crypto.randomUUID();
  const history = historyFrom(c.setup);
  const crisis = detectCrisis(c.query);
  const intent = crisis?.urgent ? 'urgent' : c.expected_intent;
  // Same category argument the pipeline passes (retrieval's top hit), none for urgent.
  const r = intent === 'urgent' ? null : retrieve(c.query, intent, history, { crisis });
  const category = r ? (r.faqs[0]?.doc.category || r.sources[0]?.doc.publisher || null) : null;
  const started = process.hrtime.bigint();
  const out = await actionAgent(c.query, intent, category, sessionId, history);
  const totalMs = ms(started);
  const { db } = require('../db');
  const tickets = await db.all('SELECT priority, escalated, emails_json FROM tickets WHERE session_id = ?', [sessionId]);
  const actionCalls = recorder.calls.filter(call => call.stage === 'action');
  const rawCalls = actionCalls.flatMap(call => call.toolCalls || []);
  return {
    intent,
    tools: out.actionsTaken.map(a => ({ tool: a.tool, args: a.args, error: a.result?.error || null, priority: a.result?.priority || a.args?.priority || null })),
    rawToolCalls: rawCalls.map(tc => ({ name: tc.name, problems: validateToolCall(tc.name, tc.arguments) })),
    modelTurns: actionCalls.length,
    agentError: out.error || null,
    tickets: tickets.map(t => ({ priority: t.priority, escalated: !!t.escalated, drafts: JSON.parse(t.emails_json || '[]').length })),
    totalMs: totalMs - pacingWait(recorder.calls),
    llm: recorder.calls.slice()
  };
}

// Which pipeline trace stage each kind of model call happens inside.
const STAGE_OF_CALL_STAGE = { router: 'router', retrieval: 'answer', action: 'action' };
const pacingWait = (calls, stage) => calls.filter(call => !stage || call.stage === stage).reduce((sum, call) => sum + (call.waitMs || 0), 0);

async function pipelineRecord(c, recorder, runPipeline) {
  recorder.calls = [];
  const sessionId = crypto.randomUUID();
  for (const turn of c.setup) await runPipeline({ message: turn, sessionId });
  // Only the final turn's model calls count toward this case's metrics.
  recorder.calls = [];
  const events = [];
  const started = process.hrtime.bigint();
  const out = await runPipeline({ message: c.query, sessionId, emit: e => { if (e.type !== 'token') events.push(e); } });
  const totalMs = ms(started);
  const retrieved = events.find(e => e.type === 'retrieved');
  const agentCalls = out.actions.filter(a => !a.forcedByCritic);
  return {
    intent: out.intent,
    routerIntent: out.trace.find(s => s.stage === 'router')?.intent ?? null,
    routerConfidence: out.routerConfidence,
    routerIncident: out.trace.find(s => s.stage === 'router')?.incident ?? null,
    matchType: out.matchType,
    source: out.source,
    retrieved: { faqIds: retrieved?.faqIds || [], sourceIds: (retrieved?.sources || []).map(s => s.id), scores: retrieved?.scores || null },
    citations: out.citations.map(x => ({ id: x.id, cited: x.cited })),
    criticFlags: out.criticFlags,
    crisis: out.crisis,
    escalated: out.escalated,
    actionAgentRan: out.trace.some(s => s.stage === 'action' && s.status === 'done'),
    agentTools: agentCalls.map(a => ({ tool: a.tool, args: a.args, error: a.result?.error || null, priority: a.result?.priority || a.args?.priority || null })),
    criticTools: out.actions.filter(a => a.forcedByCritic).map(a => a.tool),
    ticketsCreated: new Set(out.actions.filter(a => a.tool === 'create_ticket' && a.result?.ticketId).map(a => a.result.ticketId)).size,
    groqFailed: out.metadata?.error === 'groq_failed',
    answer: out.response,
    // Stage and end-to-end timings minus the harness's own pacing waits (the
    // pacer sleeps inside the model call, so it would otherwise inflate them).
    stages: Object.fromEntries(out.trace.filter(s => s.ms !== undefined).map(s => [s.stage, s.ms - (STAGE_OF_CALL_STAGE[s.stage] ? pacingWait(recorder.calls, STAGE_OF_CALL_STAGE[s.stage]) : 0)])),
    totalMs: totalMs - pacingWait(recorder.calls),
    pacingWaitMs: pacingWait(recorder.calls),
    llm: recorder.calls.slice()
  };
}

function routerFingerprint() {
  return crypto.createHash('sha256').update(`${MODEL}\n${ROUTER_SYSTEM_PROMPT}`).digest('hex').slice(0, 12);
}

function gitInfo() {
  try {
    const commit = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

async function main() {
  const dataset = loadDataset();
  let cases = dataset.cases;
  if (args.split) cases = cases.filter(c => c.split === args.split);
  if (args.category) cases = cases.filter(c => args.category.includes(c.category));
  if (args.ids) cases = cases.filter(c => args.ids.includes(c.id));
  if (args.limit) cases = cases.slice(0, args.limit);
  if (!cases.length) throw new Error('No cases selected.');

  let replay = null;
  if (args.replay) {
    // Runs recorded before 400s were scored as model failures marked those cases
    // as errors. Their live record (router intent null) is the real outcome, so
    // replay it as a routing failure instead of dropping the case.
    const rejectedOnly = r => (r.live?.llm || []).some(call => call.error) && r.live.llm.every(call => !call.error || call.error.status === 400);
    const markRejected = call => (call.error?.status === 400 && !call.malformed.length ? { ...call, malformed: [`${call.stage} output rejected by JSON validation`] } : call);
    replay = {};
    // Comma-separated: several recorded runs can together cover the dataset.
    for (const file of args.replay.split(',')) {
      const recorded = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
      if (recorded.meta.mode !== 'router') throw new Error(`${file} is not a router-mode run`);
      if (recorded.meta.routerFingerprint !== routerFingerprint()) throw new Error(`${file} was recorded with a different router prompt or model (${recorded.meta.routerFingerprint} vs ${routerFingerprint()}); re-run live instead.`);
      for (const r of recorded.cases) {
        if (r.live && (!r.error || rejectedOnly(r))) replay[r.id] = { ...r.live, llm: r.live.llm.map(markRejected) };
      }
    }
  }
  const fingerprint = LIVE ? cache.configFingerprint(args.mode, { model: MODEL, prompts: args.mode === 'router' ? [ROUTER_SYSTEM_PROMPT] : [] }) : null;
  const cached = args.resume ? cache.loadCache(args.mode) : new Map();
  const cacheStats = { fresh: 0, stale: 0, live: 0, skipped: 0 };
  const recorder = CALLS_API ? instrument(groq, { tokensPerMinute: Number(process.env.EVAL_TPM || 7000), validIntents: VALID_INTENTS, toolNames: TOOL_NAMES }) : null;
  const runPipeline = args.mode === 'pipeline' ? require('../pipeline').runPipeline : null;
  // The agent only runs for these intents in production, so only they're evaluated.
  const agentEligible = c => c.expected_tool !== null && (ACTION_AGENT_INTENTS.includes(c.expected_intent) || detectCrisis(c.query)?.urgent);
  if (args.mode === 'agent') cases = cases.filter(agentEligible);
  if (!cases.length) throw new Error('No cases selected.');
  const maxAttempts = Number(process.env.EVAL_MAX_ATTEMPTS || 3);
  const startedAt = new Date();
  say(`eval: ${args.mode} mode, ${cases.length} of ${dataset.cases.length} cases${LIVE ? `, model ${MODEL}` : ''}${replay ? ` (replaying ${args.replay})` : ''}`);

  const records = [];
  let aborted = null;
  for (const [index, c] of cases.entries()) {
    appLogs.length = 0;
    const record = { id: c.id, offline: offlineRecord(c), attempts: 0, error: null };
    const hit = LIVE && args.resume ? cache.lookup(cached, c, args.mode, fingerprint) : { status: 'miss' };
    const reuse = hit.status === 'fresh' || (hit.status === 'stale' && args.allowStale);
    if (reuse) {
      cacheStats[hit.status]++;
      record.cached = { status: hit.status, recordedAt: hit.entry.recordedAt };
      record.attempts = hit.entry.attempts;
      // Router outputs are re-scored with the current code; other modes reuse the whole record.
      record.live = args.mode === 'router' ? await routerRecord(c, null, { [c.id]: hit.entry.live }) : hit.entry.live;
    } else if (args.cachedOnly) {
      cacheStats.skipped++;
      continue;
    } else if (LIVE) {
      if (CALLS_API) cacheStats.live++;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        record.attempts = attempt;
        record.error = null;
        try {
          record.live = args.mode === 'router' ? await routerRecord(c, recorder, replay)
            : args.mode === 'agent' ? await agentRecord(c, recorder)
            : await pipelineRecord(c, recorder, runPipeline);
        } catch (error) {
          record.error = { kind: 'exception', message: String(error?.message || error).slice(0, 300) };
        }
        // A rate-limited or failed model call degrades the app to its fallbacks,
        // which would be scored as a wrong answer. Retry the case instead; if it
        // keeps failing, it's reported under reliability, not quality.
        const failedCalls = (record.live?.llm || []).filter(isInfraError);
        if (!record.error && !failedCalls.length) break;
        const limited = failedCalls.find(call => call.error.status === 429);
        // Waits longer than EVAL_MAX_WAIT_MIN (default 5) usually mean the daily quota: stop
        // cleanly so --resume can continue later, instead of sleeping for hours.
        if (limited && (limited.error.retryAfterMs || 0) > Number(process.env.EVAL_MAX_WAIT_MIN || 5) * 60_000) {
          aborted = `rate limit with retry-after ${Math.round(limited.error.retryAfterMs / 60000)} min (daily token quota?) at case ${c.id}`;
          break;
        }
        if (!record.error) record.error = { kind: 'llm_error', message: failedCalls.map(call => `${call.stage}: ${call.error.status ?? ''} ${call.error.message}`).join('; ').slice(0, 300) };
        if (attempt < maxAttempts) await sleep(limited?.error.retryAfterMs || 5000 * attempt);
      }
      if (CALLS_API && record.live && !record.error) {
        cache.appendCache(args.mode, {
          id: c.id, fingerprint, caseHash: cache.caseInputHash(args.mode, c), recordedAt: new Date().toISOString(), model: MODEL, attempts: record.attempts,
          live: args.mode === 'router' ? { router: record.live.router, llm: record.live.llm } : record.live
        });
      }
    }
    if (record.live?.answer !== undefined) {
      record.live.fabrication = scanAnswer(record.live.answer, { userText: [...c.setup, c.query].join(' ') });
      // Deterministic, so recomputed on every run (cached answers included).
      record.live.groundedness = groundedness(c, record.live);
    }
    record.logs = appLogs.filter(l => l.startsWith('ERROR')).slice(0, 10);
    records.push(record);
    if (LIVE) say(`[${index + 1}/${cases.length}] ${c.id}${record.cached ? ` (cached, ${record.cached.status})` : ''}${record.error ? `  ERROR ${record.error.kind}: ${record.error.message.slice(0, 120)}` : ''}`);
    if (aborted) {
      say(`eval: stopping early: ${aborted}`);
      if (record.error) records.pop();
      break;
    }
  }

  const meta = {
    mode: args.mode,
    label: args.label,
    replayedFrom: args.replay || null,
    model: LIVE ? MODEL : null,
    datasetVersion: dataset.version,
    datasetSize: dataset.cases.length,
    casesRun: records.length,
    cache: LIVE ? { resume: args.resume, allowStale: args.allowStale, fingerprint, ...cacheStats } : null,
    filters: { split: args.split, category: args.category, ids: args.ids, limit: args.limit },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    git: gitInfo(),
    node: process.version,
    // Identifies the router configuration, so stored router outputs are only
    // re-scored (--replay) against the same prompt and model.
    routerFingerprint: routerFingerprint(),
    aborted,
    pricing: process.env.EVAL_PRICE_INPUT_PER_M && process.env.EVAL_PRICE_OUTPUT_PER_M
      ? { inputPerM: Number(process.env.EVAL_PRICE_INPUT_PER_M), outputPerM: Number(process.env.EVAL_PRICE_OUTPUT_PER_M), source: 'EVAL_PRICE_* environment variables' }
      : null
  };
  const byId = Object.fromEntries(cases.map(c => [c.id, c]));
  const results = summarize({ meta, records, casesById: byId });

  const name = [args.mode, args.split, args.label].filter(Boolean).join('-');
  const outDir = args.out ? path.resolve(args.out) : path.join(__dirname, 'results', name);
  fs.mkdirSync(outDir, { recursive: true });
  // Results are uploaded as CI artifacts, which GitHub does not mask. Nothing
  // here should contain the key, but an error message echoing a request could;
  // scrub its literal value from everything written, as a backstop.
  const scrub = text => (process.env.GROQ_API_KEY && process.env.GROQ_API_KEY.length > 8 ? text.split(process.env.GROQ_API_KEY).join('[REDACTED]') : text);
  fs.writeFileSync(path.join(outDir, 'eval-results.json'), scrub(JSON.stringify(results, null, 2)) + '\n');
  fs.writeFileSync(path.join(outDir, 'eval-report.md'), scrub(renderReport(results)));
  recorder?.restore();

  say(`eval: wrote ${path.relative(process.cwd(), outDir)}${path.sep}eval-results.json and eval-report.md`);
  for (const line of results.headline) say(`  ${line}`);
  if (aborted) process.exitCode = 3;
}

main().catch(error => {
  originalError('eval failed:', error);
  process.exit(1);
});
