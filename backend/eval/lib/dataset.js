// Loads eval/dataset.json and validates every case against the live code: the
// router's intents, real passage and FAQ ids, the crisis detector's category
// ids, and the action agent's tool names. A label that drifts from the system
// (a renamed intent, a passage dropped by a re-scrape) fails loudly here, and
// in CI via test/eval-dataset.test.js, instead of quietly skewing a metric.
const fs = require('fs');
const path = require('path');
const { VALID_INTENTS } = require('../../pipeline/router');
const { ACTION_TOOLS } = require('../../pipeline/action');
const { CATEGORIES } = require('../../lib/crisis');
const { officialSources, allFAQs } = require('../../lib/knowledge');

const DATASET_PATH = path.join(__dirname, '..', 'dataset.json');

const TOOL_NAMES = ACTION_TOOLS.map(t => t.function.name);
const EXPECTED_TOOLS = ['none', ...TOOL_NAMES];
const CRISIS_IDS = CATEGORIES.map(c => c.id);
const DIFFICULTIES = ['easy', 'medium', 'hard'];
// dev: used while developing fixes.
// targeted: written just before the first round of fixes to probe known
//   weaknesses. The fixes were designed with these phrasings in view, so it is
//   NOT independent evidence of generalization.
// fresh: written after those fixes were frozen and never used to change code;
//   the closest thing here to a held-out set (same author, so still not blind).
const SPLITS = ['dev', 'targeted', 'fresh'];
const CATEGORIES_ALLOWED = [
  'info_housing', 'info_rent_money', 'info_food', 'info_transit', 'info_health', 'info_bylaws', 'info_academic', 'info_social',
  'out_of_scope', 'ambiguous', 'retrieval_hard', 'safety_crisis', 'safety_housing_emergency', 'safety_hard_negative',
  'tool_incident', 'tool_no_action', 'security_injection', 'security_unsupported_action', 'security_fabrication',
  'robustness_input', 'memory_followup', 'retrieval_negative'
];
const REQUIRED = ['id', 'category', 'difficulty', 'query', 'expected_intent', 'expected_source_ids', 'expected_crisis', 'should_escalate', 'expected_tool'];

function knownSourceIds() {
  return new Set([...officialSources.map(s => s.id), ...allFAQs().map(f => f.id)]);
}

// Returns a list of human-readable problems; empty means valid.
function validateCases(cases) {
  const problems = [];
  const sourceIds = knownSourceIds();
  const seen = new Set();

  cases.forEach((c, i) => {
    const where = `case ${c.id || `#${i}`}`;
    for (const key of REQUIRED) if (!(key in c)) problems.push(`${where}: missing "${key}"`);
    if (seen.has(c.id)) problems.push(`${where}: duplicate id`);
    seen.add(c.id);

    if (typeof c.query !== 'string' || !c.query.trim()) problems.push(`${where}: query must be a non-empty string`);
    if (!CATEGORIES_ALLOWED.includes(c.category)) problems.push(`${where}: unknown category "${c.category}"`);
    if (!DIFFICULTIES.includes(c.difficulty)) problems.push(`${where}: difficulty must be one of ${DIFFICULTIES.join(', ')}`);
    if (c.split !== undefined && !SPLITS.includes(c.split)) problems.push(`${where}: split must be one of ${SPLITS.join(', ')}`);
    if (c.expected_intent !== null && !VALID_INTENTS.includes(c.expected_intent)) problems.push(`${where}: unknown intent "${c.expected_intent}"`);
    for (const intent of c.acceptable_intents || []) {
      if (!VALID_INTENTS.includes(intent)) problems.push(`${where}: unknown acceptable intent "${intent}"`);
    }
    if (!Array.isArray(c.expected_source_ids)) problems.push(`${where}: expected_source_ids must be an array`);
    for (const id of c.expected_source_ids || []) {
      if (!sourceIds.has(id)) problems.push(`${where}: unknown source id "${id}"`);
    }
    if (c.retrieval_should_be_empty && c.expected_source_ids?.length) problems.push(`${where}: retrieval_should_be_empty with labeled sources`);
    if (c.expected_crisis !== null && !CRISIS_IDS.includes(c.expected_crisis)) problems.push(`${where}: unknown crisis id "${c.expected_crisis}"`);
    for (const id of c.acceptable_crisis || []) if (!CRISIS_IDS.includes(id)) problems.push(`${where}: unknown acceptable crisis "${id}"`);
    for (const tool of c.acceptable_tools || []) if (!EXPECTED_TOOLS.includes(tool)) problems.push(`${where}: unknown acceptable tool "${tool}"`);
    if (![true, false, null].includes(c.should_escalate)) problems.push(`${where}: should_escalate must be true, false or null`);
    if (c.expected_crisis && c.should_escalate === false) problems.push(`${where}: a labeled crisis must not be should_escalate=false`);
    if (c.expected_tool !== null && !EXPECTED_TOOLS.includes(c.expected_tool)) problems.push(`${where}: unknown tool "${c.expected_tool}"`);
    if (c.setup && (!Array.isArray(c.setup) || c.setup.some(t => typeof t !== 'string'))) problems.push(`${where}: setup must be an array of strings`);
    for (const pattern of c.answer_checks?.must_not_match || []) {
      try { new RegExp(pattern, 'i'); } catch { problems.push(`${where}: bad regex ${pattern}`); }
    }
  });
  return problems;
}

// Fills optional fields with their defaults so the harness never has to.
function normalize(c) {
  return {
    split: 'dev',
    setup: [],
    acceptable_intents: [],
    acceptable_crisis: [],
    acceptable_tools: [],
    retrieval_should_be_empty: false,
    answer_checks: null,
    tool_checks: null,
    notes: '',
    ...c
  };
}

function loadDataset(file = DATASET_PATH) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const problems = validateCases(raw.cases);
  if (problems.length) throw new Error(`Invalid eval dataset:\n  ${problems.join('\n  ')}`);
  return { version: raw.version, cases: raw.cases.map(normalize) };
}

module.exports = { SPLITS, DATASET_PATH, TOOL_NAMES, CRISIS_IDS, CATEGORIES_ALLOWED, loadDataset, validateCases, normalize };
