// Resumable live evals. Groq's free tier allows ~200k tokens a day and a full
// pipeline case costs ~5k, so a complete live run spans several quota
// windows. Every finished case is appended to eval/cache/<mode>.jsonl; a later
// run with --resume reuses cached cases instead of paying for them again.
//
// A cached case is only reused while it is still valid: its entry records a
// fingerprint of everything that could change the live result (model, the
// prompts and tool schemas, and for agent/pipeline modes the source files the
// model's inputs come from) plus a hash of the case's own inputs. Change any of
// those and the case is stale and re-runs (or, with --allow-stale, is reused
// but reported as stale).
//
// Router mode caches only the router's output; routing-dependent metrics are
// recomputed with the current code on every run, so rule or retrieval changes
// never make router entries stale.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isInfraError } = require('./llm-recorder');

// EVAL_CACHE_DIR points dry runs (e.g. against a scripted model) somewhere else,
// so they can never be mistaken for real model results on --resume.
const CACHE_DIR = process.env.EVAL_CACHE_DIR || path.join(__dirname, '..', 'cache');
const BACKEND = path.join(__dirname, '..', '..');
const hash = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

// Files whose content reaches the model's input (context, tool results) or
// decides what gets called. Changing any of them can change a live result.
const SOURCE_FILES = {
  router: [],
  agent: ['pipeline/action.js', 'pipeline/memory.js', 'pipeline/retrieval.js', 'lib/tickets.js', 'lib/knowledge.js', 'faq.json', 'sources/official.json'],
  pipeline: ['pipeline/index.js', 'pipeline/router.js', 'pipeline/retrieval.js', 'pipeline/action.js', 'pipeline/memory.js', 'lib/critic.js', 'lib/crisis.js', 'lib/knowledge.js', 'lib/tickets.js', 'lib/llm.js', 'faq.json', 'sources/official.json']
};

function configFingerprint(mode, { model, prompts }) {
  const files = (SOURCE_FILES[mode] || []).map(f => `${f}:${hash(fs.readFileSync(path.join(BACKEND, f), 'utf8'))}`);
  return hash([mode, model, ...prompts, ...files].join('\n'));
}

// The inputs that define a case for a given mode (labels don't affect the
// live result, so relabeling a case doesn't invalidate it).
function caseInputHash(mode, c) {
  return hash(JSON.stringify(mode === 'agent' ? [c.query, c.setup, c.expected_intent] : [c.query, c.setup]));
}

function cachePath(mode) {
  return path.join(CACHE_DIR, `${mode}.jsonl`);
}

// All entries per case id, oldest first (different configurations can coexist).
function loadCache(mode) {
  const file = cachePath(mode);
  if (!fs.existsSync(file)) return new Map();
  const entries = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entries.has(entry.id)) entries.set(entry.id, []);
      entries.get(entry.id).push(entry);
    } catch {
      // A line cut off by a crash mid-write; ignore it (that case just re-runs).
    }
  }
  return entries;
}

function appendCache(mode, entry) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.appendFileSync(cachePath(mode), JSON.stringify(entry) + '\n');
}

// Returns { entry, status: 'fresh' | 'stale' | 'miss' }. An entry whose model
// calls include an infrastructure failure (429, 5xx, network) never finished,
// whatever wrote it, so it is never reused.
function lookup(cache, c, mode, fingerprint) {
  const entries = (cache.get(c.id) || []).filter(e => !e.error && !(e.live?.llm || []).some(isInfraError));
  if (!entries.length) return { entry: null, status: 'miss' };
  const caseHash = caseInputHash(mode, c);
  const fresh = entries.filter(e => e.fingerprint === fingerprint && e.caseHash === caseHash).pop();
  return fresh ? { entry: fresh, status: 'fresh' } : { entry: entries[entries.length - 1], status: 'stale' };
}

module.exports = { CACHE_DIR, configFingerprint, caseInputHash, loadCache, appendCache, lookup };
