// Pure metric functions for the eval. No I/O, no app imports, so they're unit
// tested on their own (test/eval-metrics.test.js) and the numbers in a report
// can be trusted independently of the harness that produced them.

const ratio = (n, d) => (d ? n / d : null);
const round = (x, digits = 4) => (x === null || x === undefined ? null : Math.round(x * 10 ** digits) / 10 ** digits);

// Multi-class classification over { expected, predicted } pairs. `labels` fixes
// the row/column order of the confusion matrix; predictions outside it (e.g.
// null when the router failed) get their own "(none)" column so they're
// visible instead of silently dropped.
function classificationReport(pairs, labels) {
  const NONE = '(none)';
  const columns = [...labels];
  if (pairs.some(p => !labels.includes(p.predicted))) columns.push(NONE);
  const col = p => (labels.includes(p) ? p : NONE);

  const matrix = Object.fromEntries(labels.map(l => [l, Object.fromEntries(columns.map(c => [c, 0]))]));
  for (const { expected, predicted } of pairs) {
    if (!matrix[expected]) continue;
    matrix[expected][col(predicted)]++;
  }

  const perClass = {};
  for (const label of labels) {
    const tp = matrix[label][label];
    const support = columns.reduce((sum, c) => sum + matrix[label][c], 0);
    const predictedCount = labels.reduce((sum, row) => sum + matrix[row][label], 0);
    const precision = ratio(tp, predictedCount);
    const recall = ratio(tp, support);
    const f1 = precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : (support ? 0 : null);
    perClass[label] = { precision: round(precision), recall: round(recall), f1: round(f1), support, predicted: predictedCount };
  }

  const correct = pairs.filter(p => p.expected === p.predicted).length;
  const withSupport = labels.filter(l => perClass[l].support > 0);
  const macroF1 = withSupport.length ? withSupport.reduce((s, l) => s + (perClass[l].f1 || 0), 0) / withSupport.length : null;

  return {
    n: pairs.length,
    correct,
    accuracy: round(ratio(correct, pairs.length)),
    macroF1: round(macroF1),
    perClass,
    confusion: { labels, columns, matrix }
  };
}

// Ranking metrics over { relevant: string[], retrieved: string[] } rows, where
// `retrieved` is ranked best-first. Two recall flavours, both reported because
// labels here are "any of these passages answers the question":
//   hitAt[k]    share of queries with at least one relevant id in the top k
//               (a.k.a. success@k; what "Recall@k" usually means in RAG evals)
//   recallAt[k] mean fraction of the labeled relevant ids found in the top k
//               (classic IR recall; bounded above by k / |relevant|)
//   mrr         mean reciprocal rank of the first relevant id (0 if none in the list)
function rankingMetrics(rows, ks = [1, 3, 5]) {
  const scored = rows.filter(r => r.relevant.length > 0);
  const hitAt = {};
  const recallAt = {};
  for (const k of ks) {
    const top = r => r.retrieved.slice(0, k);
    hitAt[k] = round(ratio(scored.filter(r => top(r).some(id => r.relevant.includes(id))).length, scored.length));
    recallAt[k] = round(ratio(scored.reduce((sum, r) => sum + top(r).filter(id => r.relevant.includes(id)).length / r.relevant.length, 0), scored.length));
  }
  const reciprocal = r => {
    const rank = r.retrieved.findIndex(id => r.relevant.includes(id));
    return rank === -1 ? 0 : 1 / (rank + 1);
  };
  return { n: scored.length, hitAt, recallAt, mrr: round(ratio(scored.reduce((s, r) => s + reciprocal(r), 0), scored.length)) };
}

// Binary detection over { expected, predicted } booleans. For the safety
// critic the positive class is "must reach a person", so a false negative is
// the costly error and recall/FNR are the headline numbers.
function binaryMetrics(pairs) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const { expected, predicted } of pairs) {
    if (expected && predicted) tp++;
    else if (!expected && predicted) fp++;
    else if (expected && !predicted) fn++;
    else tn++;
  }
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);
  return {
    n: pairs.length, tp, fp, fn, tn,
    precision: round(precision),
    recall: round(recall),
    f1: round(precision !== null && recall !== null && precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : null),
    falsePositiveRate: round(ratio(fp, fp + tn)),
    falseNegativeRate: round(ratio(fn, fn + tp))
  };
}

// Nearest-rank percentile: the smallest value with at least p% of values at or below it.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1];
}

function latencySummary(values) {
  const clean = values.filter(v => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!clean.length) return { n: 0, mean: null, p50: null, p95: null, max: null };
  const mean = clean.reduce((s, v) => s + v, 0) / clean.length;
  return { n: clean.length, mean: round(mean, 2), p50: round(percentile(clean, 50), 2), p95: round(percentile(clean, 95), 2), max: round(clean[clean.length - 1], 2) };
}

module.exports = { ratio, round, classificationReport, rankingMetrics, binaryMetrics, percentile, latencySummary };
