# Eval report: router (additions-2)

|  |  |
|---|---|
| Run at | 2026-09-30T22:57:49.025Z |
| Mode | router |
| Model | openai/gpt-oss-120b |
| Dataset | v1, 1 of 321 cases run (ids: 1) |
| Code | a7ba9f2 + uncommitted changes |
| Node | v22.18.0 |

## Headline

- routing accuracy 100.0% (strict 100.0%, macro-F1 1) over 1 cases
- retrieval (labeled intent): passage Hit@1/3/5 0.0%/0.0%/0.0%, MRR 0 (n=1); FAQ Hit@3 0.0% (n=1); context hit 0.0%
- safety rules: escalation recall n/a, precision n/a, FPR 0.0% (hard negatives n/a) over 1 labeled cases
- safety system (router): escalation recall n/a, precision n/a, FPR 0.0%
- reliability: 0/1 cases errored after retries; 0 failed model calls of 1; router malformed outputs 0/1

## Intent routing

Router LLM output vs expected_intent. "accuracy" accepts acceptable_intents; strictAccuracy does not. finalAccuracy is after the critic pre-check override.

| Metric | Value |
|---|---|
| Cases (labeled intent) | 1 |
| Accuracy (acceptable intents allowed) | 100.0% |
| Strict accuracy | 100.0% |
| Accuracy after critic override | 100.0% |
| Macro F1 | 1 |
| Router returned nothing | 0 |
| Mean confidence: correct / incorrect | 0.99 / n/a |

### Per class

| Intent | Precision | Recall | F1 | Support | Predicted |
|---|---|---|---|---|---|
| housing | n/a | n/a | n/a | 0 | 0 |
| health_safety | n/a | n/a | n/a | 0 | 0 |
| rent_money | 100.0% | 100.0% | 1 | 1 | 1 |
| food | n/a | n/a | n/a | 0 | 0 |
| transit | n/a | n/a | n/a | 0 | 0 |
| bylaws | n/a | n/a | n/a | 0 | 0 |
| academic | n/a | n/a | n/a | 0 | 0 |
| social | n/a | n/a | n/a | 0 | 0 |
| urgent | n/a | n/a | n/a | 0 | 0 |
| out_of_scope | n/a | n/a | n/a | 0 | 0 |

### Confusion matrix (rows = expected, columns = predicted)

| expected \ predicted | housing | health | rent | food | transit | bylaws | academic | social | urgent | oos |
|---|---|---|---|---|---|---|---|---|---|---|
| housing | · | · | · | · | · | · | · | · | · | · |
| health | · | · | · | · | · | · | · | · | · | · |
| rent | · | · | **1** | · | · | · | · | · | · | · |
| food | · | · | · | · | · | · | · | · | · | · |
| transit | · | · | · | · | · | · | · | · | · | · |
| bylaws | · | · | · | · | · | · | · | · | · | · |
| academic | · | · | · | · | · | · | · | · | · | · |
| social | · | · | · | · | · | · | · | · | · | · |
| urgent | · | · | · | · | · | · | · | · | · | · |
| oos | · | · | · | · | · | · | · | · | · | · |

### By category

| Category | n | Accuracy |
|---|---|---|
| info_rent_money | 1 | 100.0% |

## Retrieval

BM25 as the pipeline runs it. goldIntent = scoped by the labeled intent (isolates retrieval from routing); ungated = no intent scoping. hitAt[k] = share of queries with ≥1 labeled source in the top k ("Recall@k" in most RAG evals); recallAt[k] = mean share of labeled sources found; contextHitRate = ≥1 labeled source in what the model receives (top 3 FAQs + top 3 passages).

| Index | Scoping | n | Hit@1 | Hit@3 | Hit@5 | Recall@5 | MRR |
|---|---|---|---|---|---|---|---|
| Official passages | labeled intent | 1 | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| Official passages | ungated | 1 | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| FAQs | labeled intent | 1 | 0.0% | 0.0% | 0.0% | 0.0% | 0 |
| FAQs | ungated | 1 | 0.0% | 100.0% | 100.0% | 100.0% | 0.5 |

| Context the model receives (top 3 + top 3) | Value |
|---|---|
| Cases with labeled sources | 1 |
| ≥1 labeled source in context, labeled intent | 0.0% |
| ≥1 labeled source in context, ungated | 100.0% |
| ≥1 labeled source in context, end to end (router-chosen intent) | 0.0% |
| Nothing retrieved when the KB has no answer (n=0) | n/a |
| Retrieval latency p50 / p95 (ms) | 1.57 / 1.57 |

| Category | n | Context hit rate |
|---|---|---|
| info_rent_money | 1 | 0.0% |

## Safety (escalation to a person)

Positive = the message must reach a person (should_escalate=true: crises and housing emergencies). rules = the model-free crisis detector alone (what still works in an outage). The router/pipeline rows are the whole system.

| Layer | n | TP | **FN** | FP | Recall | Precision | FNR | FPR | FPR on hard negatives |
|---|---|---|---|---|---|---|---|---|---|
| Rules only (model-free) | 1 | 0 | 0 | 0 | n/a | n/a | n/a | 0.0% | n/a |
| System: router + rules (the action agent is not run in router mode) | 1 | 0 | 0 | 0 | n/a | n/a | n/a | 0.0% | n/a |

Rules: crisis category correct on n/a of labeled crises. Recall by type: .

## Reliability

| Metric | Value |
|---|---|
| casesRun | 1 |
| casesErrored | 0 |
| errorRate | 0.0% |
| casesRetried | 0 |
| llmCalls | 1 |
| llmCallErrors | 0 |
| llmOutputRejected | 0 |
| rateLimited | 0 |
| routerMalformedOutputs | 0 |
| routerMalformedRate | 0.0% |

## Latency (ms)

| Measure | n | Mean | p50 | p95 | Max |
|---|---|---|---|---|---|
| Retrieval (BM25) | 1 | 1.57 | 1.57 | 1.57 | 1.57 |
| LLM call: router | 1 | 515 | 515 | 515 | 515 |

## Tokens

| Stage | Calls | Avg input | Avg output |
|---|---|---|---|
| router | 1 | 429 | 89 |

Per case: 429 input + 89 output tokens on average (0 calls reported no usage). Total: 429 in / 89 out. Estimated cost per case: not computed (set EVAL_PRICE_INPUT_PER_M and EVAL_PRICE_OUTPUT_PER_M from the provider's current price list).

## Worst-performing categories

| Category | Cases | Lowest score | Scores |
|---|---|---|---|

## Failures

### Safety: rules layer (0)

_None._

### Safety: whole system (0)

_None._

### Routing (0)

_None._

### Retrieval misses (labeled intent) (1)

| Case | Category | Input | Expected | Actual | Why |
|---|---|---|---|---|---|
| `rent-reasonable-amount` | info_rent_money | What's a reasonable amount to spend on off-campus rent? | before-you-rent-2, before-you-rent-1, help-waterloo-5, faq-find-off-campus-housing | faqs [faq-utilities] passages [before-you-rent-7 (9.88), help-waterloo-1 (8.88), help-waterloo-2 (7.18)] | relevant source ranked below the top 3 or not at all |

### Retrieval false matches (context given when the KB has no answer) (0)

_None._

### Errored cases (0)

_None._
