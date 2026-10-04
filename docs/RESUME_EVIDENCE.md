# Resume evidence

Verified facts only. Each row: metric, value, dataset/split, command, result file, date, limitation. Runs 2026-09-30 to 2026-10-03, model `openai/gpt-oss-120b` on Groq (free tier), Node 22.18; commands run from `backend/`. "Replay" = recorded live router decisions re-scored with current code, no new API calls (refuses if the router prompt or model changed).

Split meanings: **dev** was used to develop fixes (tuned). **targeted** was written just before a fix, and the fix was designed with it in view (not independent). **fresh** was written after the fix it tests was frozen and never used for tuning (same author, so not blind). A dev or targeted number must never be presented as held-out.

## CLAIMABLE

| Metric | Value | Dataset / split | Command | Result file | Limitation |
|---|---|---|---|---|---|
| Evaluation dataset | 387 hand-labeled cases, 22 categories; dev 261 / targeted 56 / fresh 70 | v2 | `node -e "console.log(require('./eval/dataset.json').cases.length)"` | `backend/eval/dataset.json` | one author for labels and system |
| Automated tests | 159 passing (was 96), including 7 exact tool-loop checks with a scripted model, a regression test for quota-interrupted live cases, and invalid-tool-call classification | n/a | `npm test` | `backend/test/` | frontend untested |
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
| Full-pipeline escalation, **pre-fix** (crises and housing emergencies reaching a person) | recall **95.0%** (19/20), precision 76.0%, FNR 5.0%, FPR 17.6%; FPR on hard negatives 38.5% (5/13) | fresh, 70/70 cases (54 with an escalation label) | `npm run eval:pipeline -- --split fresh --resume` | `docs/eval/pipeline-fresh-baseline/` | action-agent prompt before `2f5b68f`. 4 of the 6 false escalations come from crisis-rule matches |
| Full-pipeline escalation, **post-fix** (final, verified) | recall **95.0%** (19/20), precision 76.0%, FNR 5.0%, FPR 17.6%; hard-negative FPR 38.5%: **identical**. Same 19 crises reached staff; the same single miss ("what's the most painless way to go?", router → `transit`, agent never ran); the same 6 false positives. 0 crisis tickets opened at `normal`; no new false escalation | same 70 fresh cases, run at `c1c3fde` across three quota windows | same | `docs/eval/pipeline-fresh-postfix/` | one crisis (`fresh-crisis-ta-touched`) reached staff through the critic's no-ticket backstop after a provider-rejected tool call |
| Over-escalation in the full pipeline | ticket-only cases that ended escalated: 2/7 → **0/7**; 5 judgment-call tickets no longer page staff | same, pre vs post | same | both folders above | small n |
| Groundedness (deterministic, no LLM judge) | pre / post: 0 of 23 / 0 of 23 citation markers point at a passage not given; labeled-correct passage cited 7/7 / 7/7; answers stating a figure absent from their own context 1/70 / 2/70 | same runs | same | same | answer prompt unchanged, so the difference is run-to-run variation; small n for the cited-correct check |
| End-to-end latency | pre p50 3.6 s / p95 14.4 s; post **p50 2.8 s / p95 5.5 s** (n=70); agent stage post p50 2.3 s / p95 3.7 s | same runs | same | same | Groq free tier, harness pacing excluded; provider load differs between days |
| Tool-call validity in the pipeline | pre: 0 hallucinated, 0 malformed of 98 calls, 1 provider-rejected (1/99 attempted); post: 0 hallucinated, 0 malformed of 90, 1 provider-rejected (1/91) | same runs | same, scored at `5d54b31` or later | same | the provider-rejected call was invisible to the old metric |
| Action agent, **before** (frozen baseline) | tool-selection accuracy 30/37 (81.1%): dev 10/15, fresh 20/22; correct no-tool 11/11; ticket-only cases escalated 7/12 (dev 5/5, fresh 2/7); escalations missed 0/8; hallucinated 0/72, malformed 0/72; p50 2.3 s / p95 5.6 s | 37 tool cases (dev 15, fresh 22) | `npm run eval:agent -- --category tool_incident,tool_no_action --resume` | `docs/eval/agent-baseline/` | 22 fresh cases; same author as the system |
| Action agent: **change** | over-escalation traced to priority criteria: every one of the 7 escalation reasons cited "high priority", and 24/26 tickets were `high` under a "serious ongoing problems" definition. Fix: priority defined by observable risk; escalate exactly urgent/high | commit `2f5b68f` (prompt and tool description only) | n/a | `docs/eval/agent-escalation-policy/comparison.md` | debugged on dev only; fresh run once |
| Action agent, **after** | accuracy 34/37 (**91.9%**): dev 12/15, **fresh 22/22**; ticket-only escalated **2/12** (fresh **0/7**); escalations missed **0/8**; correct no-tool 11/11; hallucinated 0/56, malformed 0/56; provider-rejected 1/93 turns | same 37 | `… --resume --label escalation-policy` | `docs/eval/agent-escalation-policy/` | crisis messages are not in this eval; verified separately through the full pipeline (post-fix row above) |

## CLAIMABLE WITH QUALIFICATION

| Metric | Value | Qualification | Result file |
|---|---|---|---|
| Crisis recall, router + rules | dev 28/28 (100%); **fresh 15/20 (75%)** | Always state both. Dev was tuned on; fresh is the honest number. | `docs/eval/experiment-router-prompt/report.md` |
| Rules-only crisis recall | fresh 3/15 (20%) | Shows the layered design carries recall; the rules are a model-outage backstop only. | `docs/eval/offline-fresh-final/eval-report.md` |
| Retrieval on non-dev splits | targeted context hit 40.9% → 54.5% (n=22); fresh unchanged | Targeted isn't independent; fresh has only 6 labeled retrieval cases. | `docs/eval/offline-targeted-before/`, `offline-targeted-final/` |
| `escalate_ticket` precision | before 45% (old scorer) / 65% (current scorer) → after 81.8% (current scorer) / 72.7% (old scorer) | Definitional: the current scorer counts the draft labels' acceptable escalation as justified. Always compare within one scorer. | `docs/eval/agent-escalation-policy/comparison.md` |
| Unanswerable questions: answer admits missing information | pre 1 of 10, post 0 of 10 (fresh pipeline); invented specifics 0 → 1 of 10 | Small n; the uncertainty check is a phrase heuristic. | `docs/eval/pipeline-fresh-baseline/` |
| Bugs found through the eval | quota-interrupted agent runs cached and scored as model choices (fixed in `928c6c5`); provider-rejected tool calls invisible to the invalid-call metric; whole-message crisis veto; unreachable food FAQs; outage-fallback regexes with backspace bytes; injection → staff alert; unread second copy of student messages in the critic log | Counts as engineering evidence, not a metric. | tests in `backend/test/`; commit messages |

## NOT CLAIMABLE (yet)

| Metric | Why not | How to get it |
|---|---|---|
| Anything from `docs/eval/agent-tools-partial/` | Superseded and partly invalid (a quota-interrupted case was scored). | n/a |
| Metrics under the proposed label corrections | 6 corrections proposed (drafting rule, escalation policy), not reviewed or applied; what-if only in `comparison.md` | review, apply in their own commit, re-score from cache |
| Full-pipeline numbers on dev | Not run | `npm run eval:pipeline -- --split dev --resume` |
| Answer correctness / quality | Deliberately not LLM-judged; unmeasured | human-rated sample |
| Routing accuracy on the new router prompt (all cases) | Only 135 safety-category cases re-run | `npm run eval:router -- --resume` |
| Any cost figure | No prices recorded | set `EVAL_PRICE_INPUT_PER_M` / `EVAL_PRICE_OUTPUT_PER_M` from Groq's current price list |

## Earlier round (kept for history)

Round-1 reports are unchanged in `docs/eval/` (see its index). The round-1 claim "retrieval returns nothing when the knowledge base has no answer: 100%" is **withdrawn**: it rested on 5 mostly off-topic cases; with 22 in-scope unanswerable cases the rate is 57–60% (see the threshold sweep).

## Resume bullets (each backed by rows above)

1. Built a 387-case evaluation suite for an LLM support chatbot that measures routing, retrieval, crisis escalation and tool calls, and runs in CI. On held-out cases, 19 of 20 crisis messages reached staff with zero hallucinated tool calls.
2. Found that the AI agent was paging staff for routine issues (7 of 12) and fixed its priority rules. Accuracy rose from 81% to 92% and false pages dropped to 2 of 12, and a full end-to-end re-test showed no loss in crisis escalation.
3. Tested keyword search against embedding-based retrieval. Embeddings ranked better, but half the gain came from search thresholds, neither approach rejected unanswerable questions better, and the model wouldn't fit Vercel's 250 MB limit, so I kept keyword search.

Other bullets backed by the rows above: blocked a prompt injection that could page staff (false escalations 11 → 6 of 64, no crisis-recall loss); caught and reverted an overfit safety-rule change with a held-out split.
