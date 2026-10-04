#!/usr/bin/env node
// Old vs new router prompt on the same cases. Router decisions come from
// recorded live runs of each prompt (fingerprints checked); everything
// downstream is recomputed with the current rules, so the prompt is the only
// thing that differs. Escalation follows the pipeline: the critic escalates
// when the router says urgent or the crisis detector matches anything.
//
//   node eval/experiments/compare-router-prompts.js <old runs, comma-separated> <new runs, comma-separated>
const path = require('path');
const fs = require('fs');
process.env.SQLITE_PATH = ':memory:';
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'unused';
const quiet = console.log;
console.log = () => {};
const backend = path.join(__dirname, '..', '..');
const { detectCrisis } = require(path.join(backend, 'lib', 'crisis'));
const { loadDataset } = require(path.join(backend, 'eval', 'lib', 'dataset'));
const { binaryMetrics } = require(path.join(backend, 'eval', 'lib', 'metrics'));
const { intentOk } = require(path.join(backend, 'eval', 'lib', 'summarize'));
console.log = quiet;

function routerOutputs(files) {
  const out = {};
  const prints = new Set();
  for (const file of files.split(',')) {
    const r = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    prints.add(r.meta.routerFingerprint);
    for (const c of r.cases) if (c.live?.router) out[c.id] = c.live.router.intent;
  }
  if (prints.size !== 1) throw new Error(`${files} mixes router prompts: ${[...prints]}`);
  return { intents: out, fingerprint: [...prints][0] };
}

const [oldFiles, newFiles] = process.argv.slice(2);
const before = routerOutputs(oldFiles);
const after = routerOutputs(newFiles);
if (before.fingerprint === after.fingerprint) throw new Error('both sides used the same router prompt');
const { cases } = loadDataset();
const both = cases.filter(c => c.id in before.intents && c.id in after.intents);
const escalates = (c, intent) => intent === 'urgent' || !!detectCrisis(c.query);

const pct = x => (x === null ? 'n/a' : `${(100 * x).toFixed(1)}%`);
const lines = [`# Router prompt: before (${before.fingerprint}) vs after (${after.fingerprint})`, '', `${both.length} cases with a recorded decision from both prompts. Escalation = router urgent or any crisis-rule match (current rules), as in the pipeline.`, ''];
const row = (label, subset) => {
  const labeled = subset.filter(c => c.should_escalate !== null);
  const m = side => binaryMetrics(labeled.map(c => ({ expected: c.should_escalate, predicted: escalates(c, side.intents[c.id]) })));
  const intents = subset.filter(c => c.expected_intent !== null);
  const acc = side => intents.filter(c => intentOk(c, side.intents[c.id])).length / intents.length;
  const [b, a] = [m(before), m(after)];
  return `| ${label} | ${labeled.length} | ${pct(b.recall)} → ${pct(a.recall)} (${b.tp}/${b.tp + b.fn} → ${a.tp}/${a.tp + a.fn}) | ${pct(b.falsePositiveRate)} → ${pct(a.falsePositiveRate)} (${b.fp} → ${a.fp} of ${b.fp + b.tn}) | ${pct(acc(before))} → ${pct(acc(after))} |`;
};
lines.push('| Split | Labeled | Escalation recall | False escalation | Intent accuracy |', '|---|---|---|---|---|');
for (const split of ['dev', 'targeted', 'fresh']) lines.push(row(split, both.filter(c => c.split === split)));
lines.push(row('all', both), '');
const changed = both.filter(c => escalates(c, before.intents[c.id]) !== escalates(c, after.intents[c.id]));
lines.push(`## Cases whose escalation changed (${changed.length})`, '', '| Case | Split | Should escalate | Before (intent) | After (intent) |', '|---|---|---|---|---|',
  ...changed.map(c => `| \`${c.id}\` | ${c.split} | ${c.should_escalate} | ${escalates(c, before.intents[c.id])} (${before.intents[c.id]}) | ${escalates(c, after.intents[c.id])} (${after.intents[c.id]}) |`), '');
const outDir = path.join(backend, 'eval', 'results', 'experiment-router-prompt');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'report.md'), lines.join('\n'));
quiet(lines.join('\n'));
