// The eval's metric math, checked against hand-computed values. If these are
// wrong, every number in a report is wrong, so they get their own tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { classificationReport, rankingMetrics, binaryMetrics, latencySummary, percentile } = require('../eval/lib/metrics');

test('classification report: accuracy, per-class precision/recall/F1, confusion matrix', () => {
  const pairs = [
    { expected: 'a', predicted: 'a' }, { expected: 'a', predicted: 'a' }, { expected: 'a', predicted: 'b' },
    { expected: 'b', predicted: 'b' }, { expected: 'b', predicted: 'a' },
    { expected: 'c', predicted: null }
  ];
  const r = classificationReport(pairs, ['a', 'b', 'c']);
  assert.equal(r.accuracy, 0.5);
  // a: tp 2, predicted 3 (2 a + 1 from b), support 3
  assert.equal(r.perClass.a.precision, 0.6667);
  assert.equal(r.perClass.a.recall, 0.6667);
  // b: tp 1, predicted 2, support 2
  assert.equal(r.perClass.b.precision, 0.5);
  assert.equal(r.perClass.b.recall, 0.5);
  // c: never predicted → precision undefined, recall 0, F1 0
  assert.equal(r.perClass.c.precision, null);
  assert.equal(r.perClass.c.recall, 0);
  assert.equal(r.perClass.c.f1, 0);
  // A null prediction shows up in its own column rather than vanishing.
  assert.deepEqual(r.confusion.columns, ['a', 'b', 'c', '(none)']);
  assert.equal(r.confusion.matrix.c['(none)'], 1);
  assert.equal(r.confusion.matrix.a.b, 1);
  assert.equal(r.macroF1, +((0.6667 + 0.5 + 0) / 3).toFixed(4));
});

test('ranking metrics: hit@k, fractional recall@k and MRR', () => {
  const rows = [
    { relevant: ['x'], retrieved: ['x', 'y', 'z'] },          // rank 1
    { relevant: ['x', 'w'], retrieved: ['y', 'z', 'x', 'w'] }, // first relevant at rank 3
    { relevant: ['x'], retrieved: [] },                       // miss
    { relevant: [], retrieved: ['x'] }                        // unlabeled: excluded
  ];
  const m = rankingMetrics(rows, [1, 3, 5]);
  assert.equal(m.n, 3);
  assert.equal(m.hitAt[1], 0.3333);
  assert.equal(m.hitAt[3], 0.6667);
  // recall@3: (1 + 1/2 + 0) / 3; recall@5: (1 + 1 + 0) / 3
  assert.equal(m.recallAt[3], 0.5);
  assert.equal(m.recallAt[5], 0.6667);
  assert.equal(m.mrr, +((1 + 1 / 3 + 0) / 3).toFixed(4));
});

test('binary metrics: false negatives and false positives are counted separately', () => {
  const m = binaryMetrics([
    { expected: true, predicted: true }, { expected: true, predicted: false },
    { expected: false, predicted: true }, { expected: false, predicted: false }, { expected: false, predicted: false }
  ]);
  assert.deepEqual([m.tp, m.fn, m.fp, m.tn], [1, 1, 1, 2]);
  assert.equal(m.recall, 0.5);
  assert.equal(m.precision, 0.5);
  assert.equal(m.falseNegativeRate, 0.5);
  assert.equal(m.falsePositiveRate, 0.3333);
});

test('binary metrics with no positives report null, not a misleading 0 or 100%', () => {
  const m = binaryMetrics([{ expected: false, predicted: false }]);
  assert.equal(m.recall, null);
  assert.equal(m.precision, null);
});

test('latency percentiles use nearest rank and ignore missing values', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  const s = latencySummary([10, null, 30, 20, undefined, 40]);
  assert.equal(s.n, 4);
  assert.equal(s.mean, 25);
  assert.equal(s.p50, 20);
  assert.equal(s.p95, 40);
  assert.deepEqual(latencySummary([]), { n: 0, mean: null, p50: null, p95: null, max: null });
});
