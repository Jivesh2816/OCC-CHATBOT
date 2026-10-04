# Eval report: pipeline (sample)

|  |  |
|---|---|
| Run at | 2026-09-30T23:01:07.810Z |
| Mode | pipeline |
| Model | openai/gpt-oss-120b |
| Dataset | v1, 4 of 321 cases run (ids: 4) |
| Code | a7ba9f2 + uncommitted changes |
| Node | v22.18.0 |

## Headline

- routing accuracy 100.0% (strict 100.0%, macro-F1 1) over 4 cases
- retrieval (labeled intent): passage Hit@1/3/5 100.0%/100.0%/100.0%, MRR 1 (n=3); FAQ Hit@3 100.0% (n=2); context hit 100.0%
- safety rules: escalation recall 100.0%, precision 100.0%, FPR 0.0% (hard negatives n/a) over 2 labeled cases
- safety system (pipeline): escalation recall 100.0%, precision 100.0%, FPR 0.0%
- tools: agent selection 100.0%, system 100.0% (n=4); execution success 100.0% of 9 calls; invalid/hallucinated 0
- reliability: 0/4 cases errored after retries; 0 failed model calls of 19; router malformed outputs 0/4

## Intent routing

Router LLM output vs expected_intent. "accuracy" accepts acceptable_intents; strictAccuracy does not. finalAccuracy is after the critic pre-check override.

| Metric | Value |
|---|---|
| Cases (labeled intent) | 4 |
| Accuracy (acceptable intents allowed) | 100.0% |
| Strict accuracy | 100.0% |
| Accuracy after critic override | 100.0% |
| Macro F1 | 1 |
| Router returned nothing | 0 |
| Mean confidence: correct / incorrect | 0.99 / n/a |

### Per class

| Intent | Precision | Recall | F1 | Support | Predicted |
|---|---|---|---|---|---|
| housing | 100.0% | 100.0% | 1 | 3 | 3 |
| health_safety | n/a | n/a | n/a | 0 | 0 |
| rent_money | n/a | n/a | n/a | 0 | 0 |
| food | n/a | n/a | n/a | 0 | 0 |
| transit | n/a | n/a | n/a | 0 | 0 |
| bylaws | n/a | n/a | n/a | 0 | 0 |
| academic | n/a | n/a | n/a | 0 | 0 |
| social | n/a | n/a | n/a | 0 | 0 |
| urgent | 100.0% | 100.0% | 1 | 1 | 1 |
| out_of_scope | n/a | n/a | n/a | 0 | 0 |

### Confusion matrix (rows = expected, columns = predicted)

| expected \ predicted | housing | health | rent | food | transit | bylaws | academic | social | urgent | oos |
|---|---|---|---|---|---|---|---|---|---|---|
| housing | **3** | · | · | · | · | · | · | · | · | · |
| health | · | · | · | · | · | · | · | · | · | · |
| rent | · | · | · | · | · | · | · | · | · | · |
| food | · | · | · | · | · | · | · | · | · | · |
| transit | · | · | · | · | · | · | · | · | · | · |
| bylaws | · | · | · | · | · | · | · | · | · | · |
| academic | · | · | · | · | · | · | · | · | · | · |
| social | · | · | · | · | · | · | · | · | · | · |
| urgent | · | · | · | · | · | · | · | · | **1** | · |
| oos | · | · | · | · | · | · | · | · | · | · |

### By category

| Category | n | Accuracy |
|---|---|---|
| info_housing | 1 | 100.0% |
| safety_crisis | 1 | 100.0% |
| tool_incident | 1 | 100.0% |
| security_injection | 1 | 100.0% |

## Retrieval

BM25 as the pipeline runs it. goldIntent = scoped by the labeled intent (isolates retrieval from routing); ungated = no intent scoping. hitAt[k] = share of queries with ≥1 labeled source in the top k ("Recall@k" in most RAG evals); recallAt[k] = mean share of labeled sources found; contextHitRate = ≥1 labeled source in what the model receives (top 3 FAQs + top 3 passages).

| Index | Scoping | n | Hit@1 | Hit@3 | Hit@5 | Recall@5 | MRR |
|---|---|---|---|---|---|---|---|
| Official passages | labeled intent | 3 | 100.0% | 100.0% | 100.0% | 100.0% | 1 |
| Official passages | ungated | 3 | 100.0% | 100.0% | 100.0% | 100.0% | 1 |
| FAQs | labeled intent | 2 | 100.0% | 100.0% | 100.0% | 100.0% | 1 |
| FAQs | ungated | 2 | 100.0% | 100.0% | 100.0% | 100.0% | 1 |

| Context the model receives (top 3 + top 3) | Value |
|---|---|
| Cases with labeled sources | 3 |
| ≥1 labeled source in context, labeled intent | 100.0% |
| ≥1 labeled source in context, ungated | 100.0% |
| ≥1 labeled source in context, end to end (router-chosen intent) | 100.0% |
| Nothing retrieved when the KB has no answer (n=0) | n/a |
| Retrieval latency p50 / p95 (ms) | 1.35 / 2.61 |

| Category | n | Context hit rate |
|---|---|---|
| info_housing | 1 | 100.0% |
| tool_incident | 1 | 100.0% |
| security_injection | 1 | 100.0% |

## Safety (escalation to a person)

Positive = the message must reach a person (should_escalate=true: crises and housing emergencies). rules = the model-free crisis detector alone (what still works in an outage). The router/pipeline rows are the whole system.

| Layer | n | TP | **FN** | FP | Recall | Precision | FNR | FPR | FPR on hard negatives |
|---|---|---|---|---|---|---|---|---|---|
| Rules only (model-free) | 2 | 1 | 0 | 0 | 100.0% | 100.0% | 0.0% | 0.0% | n/a |
| System: full pipeline (router + rules + action agent + critic) | 2 | 1 | 0 | 0 | 100.0% | 100.0% | 0.0% | 0.0% | n/a |

Rules: crisis category correct on 100.0% of labeled crises. Recall by type: self_harm 100.0% (n=1).

## Tool calling

Agent = tool calls the action agent itself chose; system = including tickets the critic forced. expected "none" = no tool call; a tool name = that tool must be among the calls.

| Metric | Value |
|---|---|
| Cases with a tool label | 4 |
| Agent tool-selection accuracy | 100.0% |
| System tool-selection accuracy (incl. critic) | 100.0% |
| Act / don't act: precision, recall | 100.0%, 100.0% |
| Tool calls made by the agent | 9 |
| Execution success rate | 100.0% |
| Invalid or hallucinated tool calls | 0 (0.0%) |
| Action agent runs | 3 |
| Guardrail checks violated | 0 of 1 |

## Answers

| Metric | Value |
|---|---|
| Answers produced | 4 |
| Cites ≥1 official passage when passages were given (n=3) | 100.0% |
| Answer checks (injection, unsupported actions) violated | 0 of 0 |
| Answers with unsupported specifics (heuristic) | 0 (0.0%) |

## Reliability

| Metric | Value |
|---|---|
| casesRun | 4 |
| casesErrored | 0 |
| errorRate | 0.0% |
| casesRetried | 0 |
| llmCalls | 19 |
| llmCallErrors | 0 |
| llmOutputRejected | 0 |
| rateLimited | 0 |
| routerMalformedOutputs | 0 |
| routerMalformedRate | 0.0% |
| successfulResponseRate | 100.0% |
| fallbackAnswers | 0 |

## Latency (ms)

| Measure | n | Mean | p50 | p95 | Max |
|---|---|---|---|---|---|
| Retrieval (BM25) | 4 | 1.42 | 1.35 | 2.61 | 2.61 |
| LLM call: router | 4 | 1241.75 | 804 | 2448 | 2448 |
| LLM call: answer | 3 | 1539.33 | 1301 | 2486 | 2486 |
| LLM call: action | 12 | 713.5 | 628 | 1325 | 1325 |
| Pipeline stage: router | 4 | 15143.25 | 1231 | 54941 | 54941 |
| Pipeline stage: critic_pre | 4 | 2.75 | 0 | 11 | 11 |
| Pipeline stage: retrieval | 4 | 1443.25 | 834 | 3637 | 3637 |
| Pipeline stage: action | 3 | 38640.67 | 56408 | 56803 | 56803 |
| Pipeline stage: critic | 4 | 0.5 | 0 | 1 | 1 |
| **End to end** | 4 | 45571.57 | 3944.96 | 114998.42 | 114998.42 |

The pipeline "retrieval" stage includes streaming the generated answer, so it is mostly LLM time.

## Tokens

| Stage | Calls | Avg input | Avg output |
|---|---|---|---|
| router | 4 | 432 | 114 |
| answer | 3 | 1181 | 585 |
| action | 12 | 1009.2 | 154.1 |

Per case: 4345.3 input + 1015 output tokens on average (0 calls reported no usage). Total: 17381 in / 4060 out. Estimated cost per case: not computed (set EVAL_PRICE_INPUT_PER_M and EVAL_PRICE_OUTPUT_PER_M from the provider's current price list).

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

### Retrieval misses (labeled intent) (0)

_None._

### Retrieval false matches (context given when the KB has no answer) (0)

_None._

### Tool selection (0)

_None._

### Tool guardrails (0)

_None._

### Answer checks (0)

_None._

### Unsupported specifics (heuristic, review manually) (0)

_None._

### Errored cases (0)

_None._
