# Retrieval experiment: BM25 vs dense vs hybrid

Run 2026-09-30T22:44:01.382Z. 217 labeled cases (all splits), k=5, same intent gating as production.

## All labeled cases

| Method | Passage Hit@1 | Hit@3 | Hit@5 | MRR | FAQ Hit@1 | FAQ Hit@3 | FAQ MRR | Context hit |
|---|---|---|---|---|---|---|---|---|
| bm25 | 50.6% | 64.9% | 70.1% | 0.5838 | 71.3% | 73.4% | 0.7261 | 70.0% |
| bm25-no-threshold | 51.3% | 72.7% | 82.5% | 0.6284 | 87.2% | 90.4% | 0.8892 | 82.0% |
| dense:all-MiniLM-L6-v2 | 58.4% | 73.4% | 81.2% | 0.664 | 88.3% | 95.7% | 0.9218 | 82.5% |
| hybrid:all-MiniLM-L6-v2 | 61.0% | 83.8% | 89.6% | 0.7231 | 91.5% | 95.7% | 0.944 | 88.9% |
| dense:bge-small-en-v1.5 | 67.5% | 82.5% | 87.7% | 0.7558 | 91.5% | 97.9% | 0.9477 | 88.0% |
| hybrid:bge-small-en-v1.5 | 63.6% | 87.7% | 91.6% | 0.7573 | 92.5% | 98.9% | 0.9574 | 91.7% |

## retrieval_hard only (n=35)

| Method | Passage Hit@1 | Hit@3 | Hit@5 | MRR | FAQ Hit@1 | FAQ Hit@3 | FAQ MRR | Context hit |
|---|---|---|---|---|---|---|---|---|
| bm25 | 28.6% | 42.9% | 45.7% | 0.3595 | 60.0% | 60.0% | 0.6 | 48.6% |
| bm25-no-threshold | 28.6% | 54.3% | 65.7% | 0.4238 | 80.0% | 80.0% | 0.8 | 62.9% |
| dense:all-MiniLM-L6-v2 | 54.3% | 62.9% | 71.4% | 0.5929 | 100.0% | 100.0% | 1 | 62.9% |
| hybrid:all-MiniLM-L6-v2 | 42.9% | 68.6% | 80.0% | 0.561 | 100.0% | 100.0% | 1 | 68.6% |
| dense:bge-small-en-v1.5 | 62.9% | 80.0% | 91.4% | 0.7305 | 80.0% | 100.0% | 0.9 | 80.0% |
| hybrid:bge-small-en-v1.5 | 51.4% | 77.1% | 85.7% | 0.6548 | 80.0% | 100.0% | 0.9 | 77.1% |

## Split: dev

| Method | Passage Hit@1 | Hit@3 | Hit@5 | MRR | FAQ Hit@1 | FAQ Hit@3 | FAQ MRR | Context hit |
|---|---|---|---|---|---|---|---|---|
| bm25 | 52.7% | 67.2% | 71.8% | 0.6027 | 74.4% | 76.7% | 0.7587 | 73.0% |
| bm25-no-threshold | 53.4% | 74.1% | 83.2% | 0.6443 | 89.5% | 93.0% | 0.9138 | 84.1% |
| dense:all-MiniLM-L6-v2 | 61.1% | 77.1% | 85.5% | 0.6976 | 88.4% | 95.3% | 0.9203 | 85.7% |
| hybrid:all-MiniLM-L6-v2 | 61.8% | 85.5% | 92.4% | 0.738 | 91.9% | 95.3% | 0.9446 | 90.5% |
| dense:bge-small-en-v1.5 | 70.2% | 85.5% | 90.8% | 0.7849 | 91.9% | 97.7% | 0.9486 | 90.5% |
| hybrid:bge-small-en-v1.5 | 65.6% | 89.3% | 92.4% | 0.7719 | 93.0% | 98.8% | 0.9593 | 93.1% |

## Split: targeted

| Method | Passage Hit@1 | Hit@3 | Hit@5 | MRR | FAQ Hit@1 | FAQ Hit@3 | FAQ MRR | Context hit |
|---|---|---|---|---|---|---|---|---|
| bm25 | 44.4% | 55.6% | 61.1% | 0.5139 | 42.9% | 42.9% | 0.4286 | 54.5% |
| bm25-no-threshold | 44.4% | 72.2% | 83.3% | 0.5926 | 57.1% | 57.1% | 0.5714 | 72.7% |
| dense:all-MiniLM-L6-v2 | 55.6% | 55.6% | 61.1% | 0.5667 | 85.7% | 100.0% | 0.9286 | 63.6% |
| hybrid:all-MiniLM-L6-v2 | 61.1% | 77.8% | 77.8% | 0.6852 | 85.7% | 100.0% | 0.9286 | 81.8% |
| dense:bge-small-en-v1.5 | 61.1% | 72.2% | 77.8% | 0.6713 | 85.7% | 100.0% | 0.9286 | 77.3% |
| hybrid:bge-small-en-v1.5 | 61.1% | 83.3% | 94.4% | 0.75 | 85.7% | 100.0% | 0.9286 | 86.4% |

## Split: fresh

| Method | Passage Hit@1 | Hit@3 | Hit@5 | MRR | FAQ Hit@1 | FAQ Hit@3 | FAQ MRR | Context hit |
|---|---|---|---|---|---|---|---|---|
| bm25 | 20.0% | 40.0% | 60.0% | 0.34 | 0.0% | 0.0% | 0 | 33.3% |
| bm25-no-threshold | 20.0% | 40.0% | 60.0% | 0.34 | 100.0% | 100.0% | 1 | 50.0% |
| dense:all-MiniLM-L6-v2 | 0.0% | 40.0% | 40.0% | 0.1333 | 100.0% | 100.0% | 1 | 50.0% |
| hybrid:all-MiniLM-L6-v2 | 40.0% | 60.0% | 60.0% | 0.4667 | 100.0% | 100.0% | 1 | 66.7% |
| dense:bge-small-en-v1.5 | 20.0% | 40.0% | 40.0% | 0.3 | 100.0% | 100.0% | 1 | 50.0% |
| hybrid:bge-small-en-v1.5 | 20.0% | 60.0% | 60.0% | 0.4 | 100.0% | 100.0% | 1 | 66.7% |

## Latency

- BM25 per query: p50 0.37 ms, p95 0.72 ms
- all-MiniLM-L6-v2: model load 163 ms, index build 3028 ms, query embedding p50 2.61 ms / p95 4.39 ms
- bge-small-en-v1.5: model load 214 ms, index build 7637 ms, query embedding p50 9.96 ms / p95 13.8 ms

## Notes

- Dense and hybrid lists have no minimum-score cut-off, so they always return k results; BM25 returns nothing below its thresholds. Ranking metrics are comparable; the "return nothing when the KB has no answer" behaviour is not measured here.
- Hybrid = reciprocal rank fusion (k=60) of the production BM25 list and the dense list.
