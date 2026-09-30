# Evaluation

How the chat pipeline is measured: what is labeled, how, what each number means, and what the numbers can't tell you.

## Quick reference

```bash
cd backend
npm run eval                 # deterministic eval, no API key (seconds). Same as --mode offline
npm run eval:compare         # compare the last offline run with eval/baselines/offline.json
npm run eval:check           # both; what CI runs on every push and PR
npm run eval:router          # + one router LLM call per case (~170k tokens for the full set)
npm run eval:pipeline -- --category tool_incident,safety_crisis   # full pipeline on a subset
node eval/run.js --mode router --replay <results.json>             # re-score stored router outputs, no API calls
node eval/compare.js --mode offline --update                       # accept new numbers as the baseline (do it in the PR that changed them)
npm run eval:http            # old black-box suite (chat, lease, scam) against a running server (EVAL_BASE_URL)
npm run eval:agent -- --resume                                     # action agent tool-calling eval
npm run eval:pipeline -- --split fresh --resume                    # any live mode, in batches, across quota windows
node eval/experiments/threshold-sweep.js                           # BM25 cut-off sweep (offline)
```

### Running live evals across quota windows

Groq's free tier allows ~200k tokens/day; a full-pipeline case costs ~5k. So live runs are resumable: every finished case is appended to `eval/cache/<mode>.jsonl` (git-ignored), and `--resume` reuses cached cases instead of paying for them again. Run any slice (`--split`, `--category`, `--ids`) on any day; a later `--resume` run over the whole set merges everything into one report.

A cached case is reused only while still valid. Each entry records a fingerprint of the model, the prompts, and (for agent and pipeline modes) the source files that feed the model's input: `pipeline/*.js`, `lib/critic.js`, `lib/crisis.js`, `lib/knowledge.js`, `lib/tickets.js`, the FAQ and passage data. It also records a hash of the case's own inputs. Change any of them and the case re-runs; `--allow-stale` reuses it anyway and the report counts it as stale. Router mode caches only the router's output and recomputes everything downstream with the current code, so rule or retrieval changes never invalidate it. When a run stops on the daily quota, the report says so and `--resume` picks up where it stopped. `EVAL_CACHE_DIR` points dry runs (against a scripted model) elsewhere so they can't be mistaken for real results.

Each run writes `eval/results/<mode>[-<split>][-<label>]/eval-results.json` (every case, every metric) and `eval-report.md` (readable summary with a failure table per area). `eval/results/` is git-ignored; results that back a documented claim are copied to `docs/eval/`.

## What runs where

| Mode | Model calls | What it measures |
|---|---|---|
| `offline` | none | Retrieval given the **labeled** intent (isolates retrieval from routing), retrieval with no intent gating, and the rule-based crisis detector. Deterministic: same code, same numbers. |
| `router` | 1 per case | Router accuracy, per-class P/R/F1, confusion matrix, and end-to-end retrieval and escalation given the router's actual choice. The action agent does not run. |
| `agent` | 1–4 per case | The action agent alone (`actionAgent()`), given the labeled intent, on cases where production would run it: action level (none / create / escalate), per-tool recall and precision, false tool calls, hallucinated tools, arguments that break the tool's JSON schema, loop bounds, injection guardrails. |
| `pipeline` | 2–4 per case | The real `runPipeline()`: answers, citations, tool calls, critic decisions, whether the student actually reaches the escalation path, latency and tokens per stage, answer checks, groundedness. |

All modes run the app in-process with **side effects contained**: `SQLITE_PATH=:memory:`, Turso and staff alert settings are removed from the environment, and `fetch` is wrapped so any request to a host other than `api.groq.com` throws. Tickets and escalations happen for real, but only in a throwaway database.

A model call that fails for infrastructure reasons (429, 5xx, timeout) makes the pipeline fall back, which would be scored as a wrong answer. The harness retries those cases (up to 3 attempts, honouring `retry-after`). Cases that still fail are **excluded from quality metrics** and reported under reliability. A 400 from Groq's JSON validation is the model's own failure, so it's scored as a routing failure and a malformed output, not retried. Live runs pace themselves under `EVAL_TPM` tokens/minute (default 7000; Groq's free tier allows 8000) and stop early if the provider returns a multi-minute `retry-after` (the daily quota).

## Dataset (`dataset.json`)

387 cases (321 in version 1, 66 added in the second round: tool-calling, trust-boundary and "no answer" cases). Each has:

| Field | Meaning |
|---|---|
| `query`, `setup` | The message, and earlier user turns for multi-turn cases |
| `category`, `difficulty`, `split` | For slicing results (see below) |
| `expected_intent`, `acceptable_intents` | The router's correct label, plus others that are defensible for genuinely ambiguous messages (e.g. deposits: `housing` or `rent_money`). `null` = not scored. |
| `expected_source_ids` | Passages/FAQs that **each** answer the question (any one is enough). Empty = no retrieval label. |
| `retrieval_should_be_empty` | The knowledge base can't answer this; retrieving something is a false match |
| `expected_crisis`, `acceptable_crisis` | Crisis detector category (`self_harm`, `sexual_violence`, `violence`, `danger`, `housing_emergency`) or `null` |
| `should_escalate` | Must this reach a person? `true` for crises and housing emergencies, `false` for everything clearly not, `null` for judgment calls (e.g. a serious but non-dangerous maintenance dispute) |
| `expected_tool` | `none`, or the tool the action agent should call (`create_ticket`, `escalate_ticket`, `draft_followup_email`). `null` = not scored (including every intent the action agent never runs for, so they can't inflate the metric) |
| `answer_checks`, `tool_checks` | Regexes the answer must not match, and limits on tool arguments (ticket count, priority, addresses), for injection and unsupported-action cases |

**How ground truth was created.** Every source label was assigned by reading the passage or FAQ text (`sources/official.json`, `faq.json`), before running retrieval against it, and labels were not changed to match retriever output. Intent labels follow the router prompt's own definitions. Tool and escalation labels follow the action agent's and critic's written policies (e.g. "no heat in winter" is `high` priority in the action prompt, and high-priority tickets should be escalated). `eval/lib/dataset.js` validates every label against the live code (real intents, source ids, crisis ids, tool names) and `test/eval-dataset.test.js` runs that in CI, so a re-scrape that drops a passage or a renamed intent fails loudly.

**Categories:** information questions per intent (`info_*`), `ambiguous` (typos, slang, one-word, non-English), `retrieval_hard` (paraphrases with no lexical overlap), `safety_crisis`, `safety_housing_emergency`, `safety_hard_negative` (crisis words in benign contexts), `tool_incident` / `tool_no_action`, `security_injection`, `security_unsupported_action`, `security_fabrication`, `robustness_input`, `memory_followup`, `out_of_scope`.

**Splits, and why they exist:**

- `dev` (261): used while developing fixes.
- `targeted` (56): written right before a round of fixes (crisis rules in round 1, the router trust boundary in round 2) to probe known weaknesses. The crisis-rule changes were then written *with these phrasings in view*, so this split is **not** evidence of generalization; it's a second dev set.
- `fresh` (70): each batch written after the fix it tests was frozen (crisis rules; router trust boundary; tool-calling labels and BM25 cut-offs before those were evaluated), never used to tune anything. It's the closest thing here to a held-out set, but it has the same author as everything else, so it is not blind.

The lesson from these splits is in the results: the crisis-rule expansion scored 100% recall on `dev` and `targeted` and did no better than the original rules on `fresh` (see `docs/eval/`).

## Metrics

- **Routing:** accuracy with `acceptable_intents` allowed (headline) and strict; per-class precision/recall/F1 and macro F1; confusion matrix (a router that returns nothing gets its own `(none)` column); accuracy after the critic's pre-check override.
- **Retrieval:** computed separately for official passages and FAQs (separate BM25 indexes whose scores aren't comparable). `Hit@k` = share of queries with at least one labeled source in the top k (what most RAG evals call Recall@k). `Recall@k` = mean share of labeled sources found (classic IR recall; capped at k/|labels|). `MRR` = mean reciprocal rank of the first labeled source. **Context hit rate** = at least one labeled source in what the answer model actually receives (top 3 FAQs + top 3 passages), the number that matters most. Computed with the labeled intent (component), ungated (bare ranker), and end to end (router's intent).
- **Safety:** positive = should reach a person. Recall, precision, false-negative rate, false-positive rate overall and on `safety_hard_negative` alone (the meaningful FPR: most negatives are trivially negative). Reported for the rules alone (what still works during a model outage) and for the whole system. **False negatives are listed first in every report.**
- **Tools** (pipeline): agent selection accuracy (the agent's own calls) and system accuracy (including tickets the critic forces); act/don't-act precision and recall; execution success rate; invalid or hallucinated calls (detected from the raw model output: unknown tool names, unparseable arguments); guardrail violations.
- **Answers** (pipeline): share citing a passage when passages were given; answer-check violations; "unsupported specifics": phone numbers, emails, domains, %, $ and LTB form numbers in an answer that appear nowhere in the knowledge base or the student's message. That last one is a heuristic flag list for review, not a hallucination rate.
- **Groundedness** (pipeline, `lib/groundedness.js`), all deterministic, no LLM judge:
  - citation markers that point at no passage the model was given;
  - whether it cites a labeled-correct passage when one was given;
  - specifics absent from *its own* context (stricter than the whole-KB scan above: catches a number quoted from a passage it was never shown);
  - university-policy claims with no policy text in the context;
  - on questions the knowledge base can't answer, whether the answer acknowledges that.
  An LLM judge was deliberately not used: grading the model with the same model yields a number that's hard to defend, and these checks already cover what can be checked objectively. Correctness and completeness of advice remain unmeasured.
- **Deterministic tool-loop checks** (`test/action-agent.test.js`, scripted model): loop bounds, repeated tool requests, nonexistent tools, missing or malformed arguments, injection through arguments, JSON-encoding of the message. These are exact (pass/fail every CI run), so the live `agent` mode only has to measure the model's *choices*.
- **Reliability, latency, tokens** (live): error and retry counts, malformed outputs; p50/p95/mean per stage and end to end; token usage per stage from the API's own `usage` fields. Cost is only computed if you supply prices (`EVAL_PRICE_INPUT_PER_M`, `EVAL_PRICE_OUTPUT_PER_M`); no prices are hard-coded.

## Regression thresholds (`thresholds.json`)

- **Deterministic metrics (offline):** zero tolerance. The same code always gives the same number, so any net drop is a real change. If the drop is an intended trade-off, update the baseline in the same PR, where the diff is reviewed.
- **Live metrics:** router output at temperature 0 is close to repeatable but not guaranteed, so quality thresholds are about two binomial standard errors (routing accuracy: ~230 cases at ~90% gives SE ≈ 0.02, tolerance 0.04).
- **Safety is stricter than quality:** system crisis recall fails on any additional missed case (tolerance 0.03 < 1/28), and injection/guardrail violations have zero tolerance.
- **Latency:** only a +50% p95 increase counts, because provider latency varies with load.

These tolerances haven't yet been checked against measured run-to-run variance (that needs repeated live runs); running `--mode router` twice and comparing is the way to calibrate them.

## Known gaps

- The labels, the queries and the fixes share one author. A set written by someone else, or real (consented, anonymized) student messages, would be the real test.
- BM25 cut-offs can't be tuned into good abstention. With 22 in-scope "no answer" cases added, the current cut-offs already give unrelated context to 42.9% (dev) and 40% (fresh) of them, and lowering the cut-offs for recall makes that worse (`eval/experiments/threshold-sweep.js`). Embedding similarity separates answerable from unanswerable no better (AUC 0.78–0.82 vs BM25's 0.86, only 9 unanswerable housing/rent cases).
- Answer quality beyond the checks above (is the advice correct and complete?) isn't graded. An LLM-as-judge could do it, but it would need validating against human ratings first.
- Retrieval metrics are only as good as the labels. Where a retriever returned an unlabeled passage that also answers the question, it's scored as a miss.
