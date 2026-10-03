# Eval report: agent (escalation-policy)

|  |  |
|---|---|
| Run at | 2026-10-03T04:43:31.391Z |
| Mode | agent |
| Model | openai/gpt-oss-120b |
| Dataset | v2, 37 of 387 cases run (categories: tool_incident, tool_no_action) |
| Code | 5d54b31 + uncommitted changes |
| Node | v22.18.0 |

## Headline

- retrieval (labeled intent): passage Hit@1/3/5 47.1%/76.5%/76.5%, MRR 0.6078 (n=17); FAQ Hit@3 100.0% (n=8); context hit 79.0%
- safety rules: escalation recall n/a, precision n/a, FPR 0.0% (hard negatives n/a) over 11 labeled cases
- agent tools: accuracy 91.9% over 37 cases; false tool-call rate 0.0% (n=11); hallucinated 0/56, malformed args 0/56, provider-rejected 1/93 turns
- reliability: 0/37 cases errored after retries; 1 failed model calls of 93; router malformed outputs 0/0

## Retrieval

BM25 as the pipeline runs it. goldIntent = scoped by the labeled intent (isolates retrieval from routing); ungated = no intent scoping. hitAt[k] = share of queries with ≥1 labeled source in the top k ("Recall@k" in most RAG evals); recallAt[k] = mean share of labeled sources found; contextHitRate = ≥1 labeled source in what the model receives (top 3 FAQs + top 3 passages).

| Index | Scoping | n | Hit@1 | Hit@3 | Hit@5 | Recall@5 | MRR |
|---|---|---|---|---|---|---|---|
| Official passages | labeled intent | 17 | 47.1% | 76.5% | 76.5% | 64.7% | 0.6078 |
| Official passages | ungated | 17 | 47.1% | 76.5% | 76.5% | 64.7% | 0.6078 |
| FAQs | labeled intent | 8 | 100.0% | 100.0% | 100.0% | 100.0% | 1 |
| FAQs | ungated | 8 | 100.0% | 100.0% | 100.0% | 100.0% | 1 |

| Context the model receives (top 3 + top 3) | Value |
|---|---|
| Cases with labeled sources | 19 |
| ≥1 labeled source in context, labeled intent | 79.0% |
| ≥1 labeled source in context, ungated | 79.0% |
| Nothing retrieved when the KB has no answer (n=0) | n/a |
| Retrieval latency p50 / p95 (ms) | 1.42 / 3 |

| Category | n | Context hit rate |
|---|---|---|
| tool_incident | 8 | 75.0% |
| tool_no_action | 11 | 81.8% |

## Safety (escalation to a person)

Positive = the message must reach a person (should_escalate=true: crises and housing emergencies). rules = the model-free crisis detector alone (what still works in an outage). The router/pipeline rows are the whole system.

| Layer | n | TP | **FN** | FP | Recall | Precision | FNR | FPR | FPR on hard negatives |
|---|---|---|---|---|---|---|---|---|---|
| Rules only (model-free) | 11 | 0 | 0 | 0 | n/a | n/a | n/a | 0.0% | n/a |

Rules: crisis category correct on n/a of labeled crises. Recall by type: .

## Action agent (tool calling)

The action agent alone, given the labeled intent (no router gating, no critic backstop). Labels are multi-action (expected_actions: ticket none / create / escalate, plus draft true / false / null); correct = the calls satisfy the label or an acceptable alternative. Per-tool recall/precision: did the agent call each tool the label requires; draft_followup_email precision counts only cases whose label says whether a draft is expected (drafts where the label is silent are listed separately, not scored). Over-escalation = escalated where no acceptable label escalates; under-escalation = did not escalate where the label does. Invalid tool calls are split by kind (eval/lib/tool-calls.js).

| Metric | Value |
|---|---|
| Cases | 37 |
| Accuracy (action level + required draft) | 91.9% |
| Accuracy, dev split (n=15) | 80.0% |
| Accuracy, fresh split (n=22) | 100.0% |
| Ticket-only cases escalated (over-escalation) | 2 of 12 |
| Escalation cases not escalated (under-escalation) | 0 of 8 |
| False tool-call rate (tool called when none was needed, n=11) | 0.0% |
| Raw model tool calls | 56 |
| Hallucinated tool rate | 0.0% |
| Malformed argument rate (vs the JSON schema) | 0.0% |
| Invalid tool calls, model-side (all kinds) | 1.8% |
| Loop-bound compliance (≤4 model turns, ≤6 tool calls) | 100.0% |
| Guardrail checks violated | 0 of 0 |
| Agent latency p50 / p95 (ms) | 2466.5 / 6782.19 |

| Invalid tool calls, by kind | Count | Rate | Denominator |
|---|---|---|---|
| Hallucinated tool (does not exist) | 0 | 0.0% | 56 raw model tool calls |
| Malformed arguments (not JSON, or break the tool schema) | 0 | 0.0% | 56 raw model tool calls |
| Provider-rejected tool call (Groq 400, unparseable generation) | 1 | 1.1% | 93 action-agent model turns |
| **Any model-side invalid call** (the three above) | 1 | 1.8% | 57 attempted calls (raw + rejected) |
| Server-side rejection (app validation refused a well-formed call) | 0 | 0.0% | 56 executed calls |

| Tool | Expected in | Called in | Called where the label is silent (not scored) | Recall | Precision |
|---|---|---|---|---|---|
| create_ticket | 26 | 25 | 0 | 96.2% | 100.0% |
| escalate_ticket | 8 | 11 | 0 | 100.0% | 81.8% |
| draft_followup_email | 5 | 20 | 15 | 100.0% | 100.0% |

| Split | n | Accuracy | Ticket-only escalated | Escalation missed |
|---|---|---|---|---|
| dev | 15 | 80.0% | 2 of 5 | 0 of 4 |
| fresh | 22 | 100.0% | 0 of 7 | 0 of 4 |

Action level confusion (rows = expected, columns = what the agent did):

| expected \ actual | none | create | escalate |
|---|---|---|---|
| none | 11 | · | · |
| create | 1 | 14 | 3 |
| escalate | · | · | 8 |

## Reliability

| Metric | Value |
|---|---|
| casesRun | 37 |
| casesErrored | 0 |
| errorRate | 0.0% |
| casesRetried | 0 |
| llmCalls | 93 |
| llmCallErrors | 1 |
| llmOutputRejected | 1 |
| rateLimited | 0 |
| routerMalformedOutputs | 0 |
| routerMalformedRate | n/a |

## Latency (ms)

| Measure | n | Mean | p50 | p95 | Max |
|---|---|---|---|---|---|
| Retrieval (BM25) | 37 | 1.5 | 1.42 | 3 | 5.53 |
| LLM call: action | 92 | 958.05 | 734 | 2727 | 4860 |

## Tokens

| Stage | Calls | Avg input | Avg output |
|---|---|---|---|
| action | 92 | 1110.3 | 152 |

Per case: 2760.9 input + 377.8 output tokens on average (1 calls reported no usage). Total: 102152 in / 13980 out. Estimated cost per case: not computed (set EVAL_PRICE_INPUT_PER_M and EVAL_PRICE_OUTPUT_PER_M from the provider's current price list).

## Worst-performing categories

| Category | Cases | Lowest score | Scores |
|---|---|---|---|
| tool_incident | 26 | 75.0% | retrievalContextHit 75.0% |
| tool_no_action | 11 | 81.8% | retrievalContextHit 81.8%, safetyRulesAccuracy 100.0% |

## Failures

### Safety: rules layer (0)

_None._

### Retrieval misses (labeled intent) (4)

| Case | Category | Input | Expected | Actual | Why |
|---|---|---|---|---|---|
| `tool-landlord-harassing-texts` | tool_incident | My landlord has been harassing me with texts at 2am demanding I move out | renting-ontario-your-rights-3 | faqs [] passages [] | nothing scored above the minimum BM25 score |
| `tool-illegal-eviction-scared` | tool_incident | My landlord is threatening to evict me illegally and I'm really scared | renting-ontario-your-rights-3 | faqs [] passages [] | nothing scored above the minimum BM25 score |
| `tool-none-inspection-frequency` | tool_no_action | General question: how often is a landlord allowed to do inspections? | know-your-rights-5 | faqs [] passages [] | nothing scored above the minimum BM25 score |
| `fresh-tool-none-eviction-options` | tool_no_action | What would my options be if a landlord ever tried to evict me? | renting-ontario-your-rights-3 | faqs [] passages [renting-ontario-your-rights-7 (7.25)] | relevant source ranked below the top 3 or not at all |

### Retrieval false matches (context given when the KB has no answer) (0)

_None._

### Action agent decisions (3)

| Case | Category | Input | Expected | Actual | Why |
|---|---|---|---|---|---|
| `tool-black-mold` | tool_incident | There's black mold growing in my bedroom and my landlord says it's my problem | create | create_ticket, escalate_ticket, draft_followup_email | agent chose level "escalate" (ticket priority high) |
| `tool-illegal-eviction-scared` | tool_incident | My landlord is threatening to evict me illegally and I'm really scared | create | create_ticket, escalate_ticket, draft_followup_email | agent chose level "escalate" (ticket priority high) |
| `tool-wellness-reach-out` | tool_incident | Can someone from campus wellness reach out to me? My living situation with my roommates is making me miserable | create | no tool calls | agent took no action |

### Action agent: invalid tool calls (1)

| Case | Category | Input | Expected | Actual | Why |
|---|---|---|---|---|---|
| `tool-wellness-reach-out` | tool_incident | Can someone from campus wellness reach out to me? My living situation with my roommates is making me miserable | a valid call to an existing tool | provider-rejected tool call: create_ticket | provider rejected the generation as an unparseable tool call (400) |

### Action agent guardrails (0)

_None._

### Errored cases (0)

_None._
