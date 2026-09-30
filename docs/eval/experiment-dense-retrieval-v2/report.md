# Retrieval experiment: BM25 vs dense vs hybrid

Run 2026-09-30T23:25:45.935Z. 236 labeled cases (all splits), k=5, same intent gating as production.

## All labeled cases

| Method | Passage Hit@1 | Hit@3 | Hit@5 | MRR | FAQ Hit@1 | FAQ Hit@3 | FAQ MRR | Context hit |
|---|---|---|---|---|---|---|---|---|
| bm25 | 51.5% | 64.8% | 69.7% | 0.5873 | 68.9% | 72.8% | 0.7112 | 69.9% |
| bm25-no-threshold | 52.1% | 72.7% | 82.4% | 0.6321 | 84.5% | 89.3% | 0.8697 | 81.8% |
| dense:all-MiniLM-L6-v2 | 57.6% | 73.9% | 81.8% | 0.6613 | 87.4% | 95.2% | 0.9141 | 83.0% |
| hybrid:all-MiniLM-L6-v2 | 61.2% | 84.2% | 89.7% | 0.7243 | 89.3% | 95.2% | 0.9294 | 89.4% |
| dense:bge-small-en-v1.5 | 66.7% | 83.0% | 87.9% | 0.7529 | 89.3% | 97.1% | 0.9328 | 88.6% |
| hybrid:bge-small-en-v1.5 | 63.6% | 87.3% | 91.5% | 0.7568 | 89.3% | 98.1% | 0.9369 | 91.5% |

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
| bm25 | 51.9% | 66.2% | 70.7% | 0.5936 | 73.6% | 75.9% | 0.75 | 72.3% |
| bm25-no-threshold | 52.6% | 72.9% | 82.7% | 0.6361 | 88.5% | 92.0% | 0.9033 | 83.3% |
| dense:all-MiniLM-L6-v2 | 60.9% | 77.4% | 85.7% | 0.6971 | 87.4% | 94.3% | 0.9098 | 85.9% |
| hybrid:all-MiniLM-L6-v2 | 60.9% | 85.7% | 92.5% | 0.732 | 90.8% | 94.3% | 0.9337 | 90.6% |
| dense:bge-small-en-v1.5 | 69.2% | 85.0% | 90.2% | 0.7768 | 90.8% | 96.5% | 0.9377 | 90.0% |
| hybrid:bge-small-en-v1.5 | 64.7% | 88.0% | 91.7% | 0.7622 | 92.0% | 97.7% | 0.9483 | 92.2% |

## Split: targeted

| Method | Passage Hit@1 | Hit@3 | Hit@5 | MRR | FAQ Hit@1 | FAQ Hit@3 | FAQ MRR | Context hit |
|---|---|---|---|---|---|---|---|---|
| bm25 | 50.0% | 60.0% | 65.0% | 0.5625 | 27.3% | 45.5% | 0.3636 | 57.1% |
| bm25-no-threshold | 50.0% | 75.0% | 85.0% | 0.6333 | 45.5% | 63.6% | 0.5455 | 75.0% |
| dense:all-MiniLM-L6-v2 | 50.0% | 55.0% | 60.0% | 0.535 | 81.8% | 100.0% | 0.9091 | 67.9% |
| hybrid:all-MiniLM-L6-v2 | 65.0% | 80.0% | 80.0% | 0.7167 | 72.7% | 100.0% | 0.8636 | 85.7% |
| dense:bge-small-en-v1.5 | 55.0% | 75.0% | 80.0% | 0.6458 | 72.7% | 100.0% | 0.8636 | 82.1% |
| hybrid:bge-small-en-v1.5 | 60.0% | 85.0% | 95.0% | 0.75 | 63.6% | 100.0% | 0.8182 | 89.3% |

## Split: fresh

| Method | Passage Hit@1 | Hit@3 | Hit@5 | MRR | FAQ Hit@1 | FAQ Hit@3 | FAQ MRR | Context hit |
|---|---|---|---|---|---|---|---|---|
| bm25 | 50.0% | 58.3% | 66.7% | 0.5583 | 80.0% | 80.0% | 0.8 | 64.7% |
| bm25-no-threshold | 50.0% | 66.7% | 75.0% | 0.5861 | 100.0% | 100.0% | 1 | 76.5% |
| dense:all-MiniLM-L6-v2 | 33.3% | 66.7% | 75.0% | 0.475 | 100.0% | 100.0% | 1 | 76.5% |
| hybrid:all-MiniLM-L6-v2 | 58.3% | 75.0% | 75.0% | 0.6528 | 100.0% | 100.0% | 1 | 82.3% |
| dense:bge-small-en-v1.5 | 58.3% | 75.0% | 75.0% | 0.6667 | 100.0% | 100.0% | 1 | 82.3% |
| hybrid:bge-small-en-v1.5 | 58.3% | 83.3% | 83.3% | 0.7083 | 100.0% | 100.0% | 1 | 88.2% |

## Abstention: does the top score separate answerable from unanswerable questions?

Housing/rent questions only (where passages are searched): 164 answerable, 9 unanswerable. AUC of the top passage score; 0.5 = no separation.

| Method | AUC |
|---|---|
| dense:all-MiniLM-L6-v2 | 0.8205 |
| dense:bge-small-en-v1.5 | 0.7818 |
| bm25 | 0.8635 |

## Latency

- BM25 per query: p50 0.38 ms, p95 0.6 ms
- all-MiniLM-L6-v2: model load 276 ms, index build 3249 ms, query embedding p50 2.86 ms / p95 4.37 ms
- bge-small-en-v1.5: model load 217 ms, index build 5789 ms, query embedding p50 5.32 ms / p95 8.17 ms

## Notes

- Dense and hybrid lists have no minimum-score cut-off, so they always return k results; BM25 returns nothing below its thresholds. Ranking metrics are comparable; the "return nothing when the KB has no answer" behaviour is not measured here.
- Hybrid = reciprocal rank fusion (k=60) of the production BM25 list and the dense list.
