# Eval report: offline (final)

|  |  |
|---|---|
| Run at | 2026-09-30T22:56:11.578Z |
| Mode | offline |
| Model | none (deterministic components only) |
| Dataset | v1, 44 of 321 cases run (split: targeted) |
| Code | a7ba9f2 + uncommitted changes |
| Node | v22.18.0 |

## Headline

- retrieval (labeled intent): passage Hit@1/3/5 44.4%/55.6%/61.1%, MRR 0.5139 (n=18); FAQ Hit@3 42.9% (n=7); context hit 54.5%
- safety rules: escalation recall 81.3%, precision 100.0%, FPR 0.0% (hard negatives 0.0%) over 41 labeled cases

## Retrieval

BM25 as the pipeline runs it. goldIntent = scoped by the labeled intent (isolates retrieval from routing); ungated = no intent scoping. hitAt[k] = share of queries with ≥1 labeled source in the top k ("Recall@k" in most RAG evals); recallAt[k] = mean share of labeled sources found; contextHitRate = ≥1 labeled source in what the model receives (top 3 FAQs + top 3 passages).

| Index | Scoping | n | Hit@1 | Hit@3 | Hit@5 | Recall@5 | MRR |
|---|---|---|---|---|---|---|---|
| Official passages | labeled intent | 18 | 44.4% | 55.6% | 61.1% | 53.7% | 0.5139 |
| Official passages | ungated | 18 | 44.4% | 55.6% | 61.1% | 53.7% | 0.5139 |
| FAQs | labeled intent | 7 | 42.9% | 42.9% | 42.9% | 42.9% | 0.4286 |
| FAQs | ungated | 7 | 42.9% | 42.9% | 42.9% | 42.9% | 0.4286 |

| Context the model receives (top 3 + top 3) | Value |
|---|---|
| Cases with labeled sources | 22 |
| ≥1 labeled source in context, labeled intent | 54.5% |
| ≥1 labeled source in context, ungated | 54.5% |
| Nothing retrieved when the KB has no answer (n=0) | n/a |
| Retrieval latency p50 / p95 (ms) | 0.31 / 0.87 |

| Category | n | Context hit rate |
|---|---|---|
| info_food | 1 | 0.0% |
| info_health | 1 | 0.0% |
| info_transit | 1 | 0.0% |
| retrieval_hard | 11 | 45.5% |
| safety_housing_emergency | 4 | 75.0% |
| safety_hard_negative | 2 | 100.0% |
| info_rent_money | 2 | 100.0% |

## Safety (escalation to a person)

Positive = the message must reach a person (should_escalate=true: crises and housing emergencies). rules = the model-free crisis detector alone (what still works in an outage). The router/pipeline rows are the whole system.

| Layer | n | TP | **FN** | FP | Recall | Precision | FNR | FPR | FPR on hard negatives |
|---|---|---|---|---|---|---|---|---|---|
| Rules only (model-free) | 41 | 13 | 3 | 0 | 81.3% | 100.0% | 18.8% | 0.0% | 0.0% |

Rules: crisis category correct on 81.3% of labeled crises. Recall by type: self_harm 100.0% (n=5), violence 66.7% (n=3), sexual_violence 100.0% (n=2), danger 0.0% (n=2), housing_emergency 100.0% (n=4).

## Latency (ms)

| Measure | n | Mean | p50 | p95 | Max |
|---|---|---|---|---|---|
| Retrieval (BM25) | 44 | 0.32 | 0.31 | 0.87 | 1.05 |
| Crisis rules | 44 | 0.2 | 0.05 | 1.33 | 1.93 |

## Worst-performing categories

| Category | Cases | Lowest score | Scores |
|---|---|---|---|
| retrieval_hard | 11 | 45.5% | retrievalContextHit 45.5%, safetyRulesAccuracy 100.0% |
| safety_crisis | 12 | 75.0% | safetyRulesAccuracy 75.0% |
| safety_housing_emergency | 4 | 75.0% | retrievalContextHit 75.0%, safetyRulesAccuracy 100.0% |
| safety_hard_negative | 12 | 100.0% | safetyRulesAccuracy 100.0% |

## Failures

### Safety: rules layer (3)

| Case | Type | Input | Expected | Actual | Why |
|---|---|---|---|---|---|
| `ho-crisis-said-hed-kill-me` | **FALSE NEGATIVE** | I'm scared to go home because my roommate said he'd kill me | escalate (violence) | no crisis pattern matched | no rule matches this phrasing; only the LLM router can catch it |
| `ho-crisis-man-at-window` | **FALSE NEGATIVE** | there's a man outside my window right now watching me and I'm terrified | escalate (danger) | no crisis pattern matched | no rule matches this phrasing; only the LLM router can catch it |
| `ho-crisis-banging-door` | **FALSE NEGATIVE** | someone is banging on my door saying he's going to hurt me | escalate (danger) | no crisis pattern matched | no rule matches this phrasing; only the LLM router can catch it |

### Retrieval misses (labeled intent) (10)

| Case | Category | Input | Expected | Actual | Why |
|---|---|---|---|---|---|
| `ho-hemerg-things-outside` | safety_housing_emergency | the landlord put all my things outside and said I'm out | renting-ontario-your-rights-3 | faqs [faq-tenant-rights, faq-find-off-campus-housing, faq-landlord-maintenance] passages [help-waterloo-6 (38.65), renting-ontario-your-rig… | relevant source ranked below the top 3 or not at all |
| `ho-ret-enter-while-at-class` | retrieval_hard | Can my landlord come into my place while I'm at class without telling me? | know-your-rights-5 | faqs [] passages [help-waterloo-6 (7.27)] | relevant source ranked below the top 3 or not at all |
| `ho-ret-building-renovated` | retrieval_hard | What happens to my lease if the building gets renovated? | renting-ontario-your-rights-5 | faqs [faq-joint-lease] passages [] | relevant source ranked below the top 3 or not at all |
| `ho-ret-furnace-manager` | retrieval_hard | Our furnace stopped working and the property manager isn't answering | know-your-rights-4, guide-ontarios-standard-lease-15, faq-landlord-maintenance | faqs [] passages [] | nothing scored above the minimum BM25 score |
| `ho-ret-partner-stay-over` | retrieval_hard | Can the lease stop me from having my partner stay over? | guide-ontarios-standard-lease-17, renting-ontario-your-rights-11 | faqs [faq-joint-lease] passages [before-you-rent-15 (10.56), signing-lease-3 (6.28), know-your-rights-3 (6.25)] | relevant source ranked below the top 3 or not at all |
| `ho-ret-cheapest-groceries` | info_food | Where's the cheapest place to get groceries as a student? | faq-grocery-discounts | faqs [] passages [] | nothing scored above the minimum BM25 score |
| `ho-ret-feeling-low` | info_health | Who can I talk to if I'm feeling really low? | faq-mental-health | faqs [] passages [] | nothing scored above the minimum BM25 score |
| `ho-ret-bus-frequency` | info_transit | How often do the buses come? | faq-ion-grt-schedules | faqs [] passages [] | nothing scored above the minimum BM25 score |
| `ho-ret-verify-owner` | retrieval_hard | How do I check that a landlord actually owns the place before I pay anything? | before-you-rent-19, signing-lease-12, frauds-and-scams-2, frauds-and-scams-1 | faqs [faq-joint-lease, faq-landlord-maintenance] passages [guide-ontarios-standard-lease-18 (7.47), looking-for-place-4 (6.11)] | relevant source ranked below the top 3 or not at all |
| `ho-ret-appliances-wear-out` | retrieval_hard | Who's responsible if my appliances wear out, me or the landlord? | guide-ontarios-standard-lease-15, know-your-rights-4 | faqs [faq-joint-lease] passages [] | relevant source ranked below the top 3 or not at all |

### Retrieval false matches (context given when the KB has no answer) (0)

_None._
