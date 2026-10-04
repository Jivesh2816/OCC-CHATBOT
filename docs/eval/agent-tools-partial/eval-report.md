> **SUPERSEDED — do not cite.** This partial run (6 of 37 cases, stopped by the daily token quota) is not a measurement, and one of its 6 cases, `tool-wellness-reach-out`, is invalid: a Groq 429 interrupted the agent's tool loop after its first turn, and a harness bug (fixed in `928c6c5`) cached and scored the partial result. The complete baseline is [`../agent-baseline/`](../agent-baseline/eval-report.md).

# Eval report: agent (tools-partial)

|  |  |
|---|---|
| Run at | 2026-09-30T23:45:13.728Z |
| Mode | agent |
| Model | openai/gpt-oss-120b |
| Dataset | v1, 6 of 387 cases run (categories: tool_incident, tool_no_action) |
| Code | a7ba9f2 + uncommitted changes |
| Node | v22.18.0 |

## Headline

- retrieval (labeled intent): passage Hit@1/3/5 20.0%/60.0%/60.0%, MRR 0.4 (n=5); FAQ Hit@3 100.0% (n=3); context hit 60.0%
- safety rules: escalation recall n/a, precision n/a, FPR n/a (hard negatives n/a) over 0 labeled cases
- agent tools: accuracy 66.7% over 6 cases; false tool-call rate n/a (n=0); hallucinated 0/16, malformed args 0/16
- reliability: 0/6 cases errored after retries; 1 failed model calls of 22; router malformed outputs 0/0

## Retrieval

BM25 as the pipeline runs it. goldIntent = scoped by the labeled intent (isolates retrieval from routing); ungated = no intent scoping. hitAt[k] = share of queries with ≥1 labeled source in the top k ("Recall@k" in most RAG evals); recallAt[k] = mean share of labeled sources found; contextHitRate = ≥1 labeled source in what the model receives (top 3 FAQs + top 3 passages).

| Index | Scoping | n | Hit@1 | Hit@3 | Hit@5 | Recall@5 | MRR |
|---|---|---|---|---|---|---|---|
| Official passages | labeled intent | 5 | 20.0% | 60.0% | 60.0% | 50.0% | 0.4 |
| Official passages | ungated | 5 | 20.0% | 60.0% | 60.0% | 50.0% | 0.4 |
| FAQs | labeled intent | 3 | 100.0% | 100.0% | 100.0% | 100.0% | 1 |
| FAQs | ungated | 3 | 100.0% | 100.0% | 100.0% | 100.0% | 1 |

| Context the model receives (top 3 + top 3) | Value |
|---|---|
| Cases with labeled sources | 5 |
| ≥1 labeled source in context, labeled intent | 60.0% |
| ≥1 labeled source in context, ungated | 60.0% |
| Nothing retrieved when the KB has no answer (n=0) | n/a |
| Retrieval latency p50 / p95 (ms) | 0.76 / 1.7 |

| Category | n | Context hit rate |
|---|---|---|
| tool_incident | 5 | 60.0% |

## Safety (escalation to a person)

Positive = the message must reach a person (should_escalate=true: crises and housing emergencies). rules = the model-free crisis detector alone (what still works in an outage). The router/pipeline rows are the whole system.

| Layer | n | TP | **FN** | FP | Recall | Precision | FNR | FPR | FPR on hard negatives |
|---|---|---|---|---|---|---|---|---|---|
| Rules only (model-free) | 0 | 0 | 0 | 0 | n/a | n/a | n/a | n/a | n/a |

Rules: crisis category correct on n/a of labeled crises. Recall by type: .

## Action agent (tool calling)

The action agent alone, given the labeled intent (no router gating, no critic backstop). Action level = none / create (ticket) / escalate (ticket + escalation); a draft label also requires draft_followup_email. acceptable_tools alternatives count as correct. Per-tool recall/precision: did the agent call each tool the label requires. Hallucinated and malformed rates are over raw model tool calls, checked against the agent's own JSON schemas.

| Metric | Value |
|---|---|
| Cases | 6 |
| Accuracy (action level + required draft) | 66.7% |
| Accuracy, dev split (n=6) | 66.7% |
| False tool-call rate (tool called when none was needed, n=0) | n/a |
| Raw model tool calls | 16 |
| Hallucinated tool rate | 0.0% |
| Malformed argument rate (vs the JSON schema) | 0.0% |
| Loop-bound compliance (≤4 model turns, ≤6 tool calls) | 100.0% |
| Guardrail checks violated | 0 of 0 |
| Agent latency p50 / p95 (ms) | 2666.21 / 4239.01 |

| Tool | Expected in | Called in | Recall | Precision |
|---|---|---|---|---|
| create_ticket | 6 | 6 | 100.0% | 100.0% |
| escalate_ticket | 2 | 5 | 100.0% | 40.0% |
| draft_followup_email | 1 | 5 | 100.0% | 20.0% |

Action level confusion (rows = expected, columns = what the agent did):

| expected \ actual | none | create | escalate |
|---|---|---|---|
| none | · | · | · |
| create | · | 1 | 3 |
| escalate | · | · | 2 |

## Reliability

| Metric | Value |
|---|---|
| casesRun | 6 |
| casesErrored | 0 |
| errorRate | 0.0% |
| casesRetried | 1 |
| llmCalls | 22 |
| llmCallErrors | 1 |
| llmOutputRejected | 0 |
| rateLimited | 1 |
| routerMalformedOutputs | 0 |
| routerMalformedRate | n/a |

## Latency (ms)

| Measure | n | Mean | p50 | p95 | Max |
|---|---|---|---|---|---|
| Retrieval (BM25) | 6 | 0.98 | 0.76 | 1.7 | 1.7 |
| LLM call: action | 21 | 759.76 | 677 | 1340 | 1656 |

## Tokens

| Stage | Calls | Avg input | Avg output |
|---|---|---|---|
| action | 21 | 1039.8 | 176.8 |

Per case: 3639.3 input + 618.7 output tokens on average (1 calls reported no usage). Total: 21836 in / 3712 out. Estimated cost per case: not computed (set EVAL_PRICE_INPUT_PER_M and EVAL_PRICE_OUTPUT_PER_M from the provider's current price list).

## Worst-performing categories

| Category | Cases | Lowest score | Scores |
|---|---|---|---|
| tool_incident | 6 | 60.0% | retrievalContextHit 60.0% |

## Failures

### Safety: rules layer (0)

_None._

### Retrieval misses (labeled intent) (2)

| Case | Category | Input | Expected | Actual | Why |
|---|---|---|---|---|---|
| `tool-landlord-harassing-texts` | tool_incident | My landlord has been harassing me with texts at 2am demanding I move out | renting-ontario-your-rights-3 | faqs [] passages [] | nothing scored above the minimum BM25 score |
| `tool-illegal-eviction-scared` | tool_incident | My landlord is threatening to evict me illegally and I'm really scared | renting-ontario-your-rights-3 | faqs [] passages [] | nothing scored above the minimum BM25 score |

### Retrieval false matches (context given when the KB has no answer) (0)

_None._

### Action agent decisions (2)

| Case | Category | Input | Expected | Actual | Why |
|---|---|---|---|---|---|
| `tool-black-mold` | tool_incident | There's black mold growing in my bedroom and my landlord says it's my problem | create_ticket | create_ticket, draft_followup_email, escalate_ticket | agent chose level "escalate" (ticket priority high) |
| `tool-illegal-eviction-scared` | tool_incident | My landlord is threatening to evict me illegally and I'm really scared | create_ticket | create_ticket, draft_followup_email, escalate_ticket | agent chose level "escalate" (ticket priority high) |

### Action agent: invalid or hallucinated calls (0)

_None._

### Action agent guardrails (0)

_None._

### Errored cases (0)

_None._
