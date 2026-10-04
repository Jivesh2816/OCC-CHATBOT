#!/usr/bin/env node
// Compares an eval run against the committed baseline for its mode and fails
// (exit 1) on any regression beyond the thresholds in eval/thresholds.json.
//
//   node eval/compare.js --mode offline                 compare eval/results/offline
//   node eval/compare.js --mode router --results <file> compare a specific run
//   node eval/compare.js --mode offline --update        make the latest run the new baseline
//
// Updating the baseline is deliberate: it's a reviewed change to
// eval/baselines/<mode>.json in the same PR as the change that moved the numbers.
const fs = require('fs');
const path = require('path');

const args = { mode: 'offline', results: null, baseline: null, update: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--mode') args.mode = argv[++i];
  else if (argv[i] === '--results') args.results = argv[++i];
  else if (argv[i] === '--baseline') args.baseline = argv[++i];
  else if (argv[i] === '--update') args.update = true;
  else { console.error(`Unknown argument ${argv[i]}`); process.exit(2); }
}

const thresholds = JSON.parse(fs.readFileSync(path.join(__dirname, 'thresholds.json'), 'utf8'))[args.mode];
if (!thresholds) { console.error(`No thresholds for mode "${args.mode}"`); process.exit(2); }
const resultsPath = args.results || path.join(__dirname, 'results', args.mode, 'eval-results.json');
const baselinePath = args.baseline || path.join(__dirname, 'baselines', `${args.mode}.json`);

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

function compare(baselineMetrics, currentMetrics) {
  return thresholds.map(t => {
    const before = baselineMetrics[t.metric];
    const after = get(currentMetrics, t.metric);
    if (typeof before !== 'number' || typeof after !== 'number') return { ...t, before, after, status: 'missing' };
    const worseBy = t.direction === 'higher' ? before - after : after - before;
    const allowed = t.relativeTolerance !== undefined ? Math.abs(before) * t.relativeTolerance : t.tolerance;
    const status = worseBy > allowed + 1e-9 ? 'REGRESSION' : worseBy < -1e-9 ? 'improved' : 'ok';
    return { ...t, before, after, delta: +(after - before).toFixed(4), allowed: +allowed.toFixed(4), status };
  });
}

function main() {
  if (!fs.existsSync(resultsPath)) {
    console.error(`No results at ${resultsPath}. Run: node eval/run.js --mode ${args.mode}`);
    process.exit(2);
  }
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  if (results.meta.mode !== args.mode) { console.error(`${resultsPath} is a ${results.meta.mode} run, not ${args.mode}`); process.exit(2); }

  if (args.update) {
    const snapshot = {
      mode: args.mode,
      updatedAt: new Date().toISOString(),
      source: { finishedAt: results.meta.finishedAt, commit: results.meta.git.commit, dirty: results.meta.git.dirty, model: results.meta.model, casesRun: results.meta.casesRun, datasetSize: results.meta.datasetSize, routerFingerprint: results.meta.routerFingerprint },
      metrics: Object.fromEntries(thresholds.map(t => [t.metric, get(results.metrics, t.metric) ?? null])),
      // The exact cases behind these numbers, so later runs are compared on the
      // same cases even after the dataset grows.
      caseIds: results.cases.map(c => c.id)
    };
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`Baseline for ${args.mode} updated: ${path.relative(process.cwd(), baselinePath)}`);
    return;
  }

  if (!fs.existsSync(baselinePath)) {
    console.error(`No baseline at ${baselinePath}. Create one with: node eval/compare.js --mode ${args.mode} --update`);
    process.exit(2);
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  let current = results.metrics;
  if (baseline.caseIds) {
    // Re-score this run on exactly the baseline's cases: a new, harder case
    // can't show up as a code regression, and a code regression can't be
    // diluted by new easy cases. New cases are reported, not gated.
    const baselineIds = new Set(baseline.caseIds);
    const same = results.cases.filter(r => baselineIds.has(r.id));
    const added = results.cases.length - same.length;
    const missing = baseline.caseIds.length - same.length;
    if (added || missing) {
      process.env.SQLITE_PATH = ':memory:';
      const quiet = console.log;
      console.log = () => {};
      const { loadDataset } = require('./lib/dataset');
      const { summarize } = require('./lib/summarize');
      const casesById = Object.fromEntries(loadDataset().cases.map(c => [c.id, c]));
      current = summarize({ meta: results.meta, records: same, casesById }).metrics;
      console.log = quiet;
      console.log(`Compared on the ${same.length} cases in the baseline${added ? `; ${added} newer case(s) are not gated (update the baseline to include them)` : ''}${missing ? `; ${missing} baseline case(s) are missing from this run` : ''}.`);
    }
  } else if (baseline.source.datasetSize !== results.meta.datasetSize) {
    console.log(`Note: dataset size changed (${baseline.source.datasetSize} → ${results.meta.datasetSize}); differences may come from new cases, not code.`);
  }

  const rows = compare(baseline.metrics, current);
  const fmt = x => (typeof x === 'number' ? String(+x.toFixed(4)) : 'n/a');
  console.log(`\nComparing ${args.mode} run (${results.meta.finishedAt}) with baseline (${baseline.source.finishedAt}, ${baseline.source.commit || '?'})\n`);
  const width = Math.max(...rows.map(r => r.metric.length));
  for (const r of rows) {
    const mark = r.status === 'REGRESSION' ? '✗' : r.status === 'improved' ? '↑' : r.status === 'missing' ? '?' : '✓';
    console.log(`${mark} ${r.metric.padEnd(width)}  ${fmt(r.before).padStart(8)} → ${fmt(r.after).padEnd(8)} ${r.status === 'REGRESSION' ? `REGRESSION (${r.severity}; allowed ${r.allowed})` : r.status}`);
  }
  const regressions = rows.filter(r => r.status === 'REGRESSION');
  const missing = rows.filter(r => r.status === 'missing');
  if (missing.length) console.log(`\n${missing.length} metric(s) missing from this run (not compared).`);
  if (regressions.length) {
    console.log(`\n${regressions.length} regression(s):`);
    for (const r of regressions) console.log(`  - ${r.metric}: ${fmt(r.before)} → ${fmt(r.after)}. Threshold rationale: ${r.why}`);
    console.log('\nIf the change is intended, update the baseline in the same PR: node eval/compare.js --mode ' + args.mode + ' --update');
    process.exit(1);
  }
  console.log('\nNo regressions.');
}

main();
