# Resume evidence

Verified facts only. Each row: metric, value, dataset/split, command, result file, date, limitation. All runs 2026-09-30, model `openai/gpt-oss-120b` on Groq (free tier), Node 22.18; commands run from `backend/`. "Replay" = recorded live router decisions re-scored with current code, no new API calls (refuses if the router prompt or model changed).

Split meanings: **dev** was used to develop fixes (tuned). **targeted** was written just before a fix, and the fix was designed with it in view (not independent). **fresh** was written after the fix it tests was frozen and never used for tuning (same author, so not blind). A dev or targeted number must never be presented as held-out.

## CLAIMABLE

| Metric | Value | Dataset / split | Command | Result file | Limitation |
|---|---|---|---|---|---|
| Evaluation dataset | 387 hand-labeled cases, 22 categories; dev 261 / targeted 56 / fresh 70 | v2 | `node -e "console.log(require('./eval/dataset.json').cases.length)"` | `backend/eval/dataset.json` | one author for labels and system |
| Automated tests | 151 passing (was 96), including 7 exact tool-loop checks with a scripted model | n/a | `npm test` | `backend/test/` | frontend untested |
| CI | tests + deterministic eval + same-case baseline comparison on every PR; live evals only manual/weekly with a dedicated key | n/a | `npm run eval:check` | `.github/workflows/ci.yml`, `eval-live.yml`, `backend/eval/baselines/offline.json` | live-eval workflow not yet run in GitHub |
| Intent routing accuracy | 96.9% with defensible alternatives, 87.1% strict; macro-F1 0.955 | 317 labeled cases, all v1 splits, original router prompt | live router runs + `--replay … --label all-final` | `docs/eval/router-all-final/eval-report.md` | the router prompt changed afterwards; only the 135 safety-category cases were re-run (94.8%) |
| Router output reliability | 1 malformed output in 322 calls | same | same | same | |
| Trust-boundary fix: crisis recall | unchanged on every split: 28/28 dev, 22/22 targeted, 15/20 fresh | 135 safety-category cases, both prompts | `node eval/experiments/compare-router-prompts.js <old runs> docs/eval/router-safety-newprompt/eval-results.json` | `docs/eval/experiment-router-prompt/report.md` | router-level (router + rules), not full pipeline |
| Trust-boundary fix: false escalations | 11 → 6 of 64 non-crisis cases (17.2% → 9.4%) | same, all splits; fresh alone 5 → 4 of 18 | same | same | same |
| Injection attacks reaching staff escalation | 3/7 → 0/7 (targeted); 2/5 → 1/5 (fresh) | trust-boundary cases | `node eval/run.js --mode router --ids <ids> --resume` with each prompt | `docs/eval/router-trust-{before,after,fresh-before,fresh-after}/` | small n; a prompt defence is probabilistic |
| Overfit rule change caught by a held-out split | crisis-regex expansion: dev recall 64% → 100%, but fresh FPR 23.1% → 46.2% with no recall gain; reverted | fresh (15 crises, 13 negatives) | `node eval/run.js --mode offline --split fresh` against each rule version | `docs/eval/offline-fresh-original-rules/`, `offline-fresh-frozen-expansion/`, `offline-fresh-final/` | |
| Retrieval fixes (context hit) | 68.3% → 73.0%; housing emergencies 12.5% → 87.5% (n=8) | dev (tuned) | `node eval/run.js --mode offline --split dev` | `docs/eval/offline-dev-before/`, `offline-dev-after-hemerg-retrieval/` | dev only (see qualified row for fresh) |
| Retrieval A/B | context hit: BM25 69.9%, BM25 without cut-offs 81.8%, dense (bge-small) 88.6%, hybrid 91.5% | 236 labeled cases, all splits | `cd eval/experiments && npm install && npm run dense-retrieval` | `docs/eval/experiment-dense-retrieval-v2/report.md` | labels limit recall (unlabeled relevant passages count as misses) |
| Abstention (answerable vs unanswerable) | AUC: BM25 0.86, MiniLM 0.82, bge-small 0.78 | 164 answerable, 9 unanswerable housing/rent cases | same | same | only 9 negatives |
| BM25 cut-offs can't be tuned into abstention | false matches on unanswerable questions: current 42.9% dev / 40% fresh; loosest cut-offs 64.3% / 70% | 14 dev, 10 fresh in-scope unanswerable | `node eval/experiments/threshold-sweep.js` | `docs/eval/experiment-threshold-sweep/report.md` | rule fixed before the sweep; no pair qualified |
| Deployment constraint | embedding runtime 379 MB installed vs Vercel's 250 MB function limit | n/a | `du -sh backend/eval/experiments/node_modules` | n/a | |
| Router latency | p50 620 ms, p95 1,449 ms, ~432 in / 116 out tokens | 247 calls | `node eval/run.js --mode router --label baseline` | `docs/eval/router-baseline/eval-report.md` | router call only, not end-to-end |

## CLAIMABLE WITH QUALIFICATION

| Metric | Value | Qualification | Result file |
|---|---|---|---|
| Crisis recall, router + rules | dev 28/28 (100%); **fresh 15/20 (75%)** | Always state both. Dev was tuned on; fresh is the honest number. | `docs/eval/experiment-router-prompt/report.md` |
| Rules-only crisis recall | fresh 3/15 (20%) | Shows the layered design carries recall; the rules are a model-outage backstop only. | `docs/eval/offline-fresh-final/eval-report.md` |
| Retrieval on non-dev splits | targeted context hit 40.9% → 54.5% (n=22); fresh unchanged | Targeted isn't independent; fresh has only 6 labeled retrieval cases. | `docs/eval/offline-targeted-before/`, `offline-targeted-final/` |
| Bugs found through the eval | whole-message crisis veto; unreachable food FAQs; outage-fallback regexes with backspace bytes; injection → staff alert; unread second copy of student messages in the critic log | Counts as engineering evidence, not a metric. | tests in `backend/test/`; commit messages |

## NOT CLAIMABLE (yet)

| Metric | Why not | How to get it |
|---|---|---|
| Action-agent tool-selection accuracy | Only 6 of 37 cases ran before the daily token quota (`docs/eval/agent-tools-partial/`). The "66.7%" in that report is not a measurement. | `npm run eval:agent -- --category tool_incident,tool_no_action --resume` over 1–2 quota windows |
| Full-pipeline escalation rate (dev / fresh) | Not run; quota | `npm run eval:pipeline -- --split fresh --resume`, then `--split dev` |
| Groundedness (invalid citations, specifics not in context, uncertainty on unanswerable questions) | Implemented; only a 4-case plumbing sample exists | same pipeline runs |
| End-to-end latency, tool vs non-tool | The 4-case sample is too small and its end-to-end timings predate the pacing-wait fix | same pipeline runs (reported per stage) |
| Answer correctness / quality | Deliberately not LLM-judged; unmeasured | human-rated sample |
| Routing accuracy on the new router prompt (all cases) | Only 135 safety-category cases re-run | `npm run eval:router -- --resume` |
| Any cost figure | No prices recorded | set `EVAL_PRICE_INPUT_PER_M` / `EVAL_PRICE_OUTPUT_PER_M` from Groq's current price list |

## Earlier round (kept for history)

Round-1 reports are unchanged in `docs/eval/` (see its index). The round-1 claim "retrieval returns nothing when the knowledge base has no answer: 100%" is **withdrawn**: it rested on 5 mostly off-topic cases; with 22 in-scope unanswerable cases the rate is 57–60% (see the threshold sweep).

## Resume bullets (suggestions, each backed by rows above)

1. Built a 387-case evaluation harness (routing, retrieval, escalation, tool calling, groundedness) for an LLM/RAG student-support assistant, with resumable live runs under API quotas and a CI gate that compares each run against a baseline on the same cases; measured 96.9% intent accuracy (87.1% strict, macro-F1 0.955) with gpt-oss-120b.
2. Traced a prompt injection that could page staff to a missing data/instruction boundary in the LLM router. Fixed it by JSON-encoding untrusted input and adding an explicit trust rule, cutting false escalations from 11 to 6 of 64 with no crisis-recall loss on dev, targeted or held-out splits. Also used a held-out split to catch and revert an overfit safety-rule change that doubled false positives.
3. A/B-tested BM25 against dense and hybrid retrieval. The hybrid raised context hit rate from 70% to 92%, but a no-cutoff control attributed half the gain to BM25 thresholds, and neither method could reject unanswerable questions better (AUC 0.86 vs 0.78). I kept BM25 because the embedding runtime (379 MB) exceeds Vercel's 250 MB function limit and would send student queries to another processor.
