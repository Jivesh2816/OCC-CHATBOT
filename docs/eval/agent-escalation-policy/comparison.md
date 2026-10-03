# Action-agent over-escalation: before → change → after

**Before:** `docs/eval/agent-baseline/` (frozen 2026-10-03, agent code as of `12a7d67`). **Change:** commit `2f5b68f`, action-agent prompt and `escalate_ticket` description only. **After:** this folder, one run of the same 37 cases (`npm run eval:agent -- --category tool_incident,tool_no_action --resume --label escalation-policy`). Model `openai/gpt-oss-120b`, both runs.

Both columns are scored by the same code (commit `5d54b31`, multi-action labels). The baseline is re-scored from its frozen cache with `EVAL_CACHE_DIR=../docs/eval/agent-baseline/cache node eval/run.js --mode agent --category tool_incident,tool_no_action --cached-only`, so its numbers match its original report except `escalate_ticket` precision. That one is 45% under the old scorer and 65% under the new one, because the draft labels' "escalating as well is acceptable" alternative is now explicit and counted consistently. Splits: these 37 cases are dev (15) and fresh (22); no tool case is in `targeted`.

## Root cause (from the baseline, before any change)

Every one of the 7 over-escalations gave "high priority" as its escalation reason. The prompt said to escalate "urgent/high priority" tickets, and the critic force-escalates any high/urgent ticket the agent leaves unescalated. The prompt defined "high" as "serious ongoing problems", which describes almost every case that warrants a ticket: 24 of 26 tickets were `high`, including a leaking faucet, an unreturned key deposit and a missing lease copy. The `escalate_ticket` description ("needs a person, not the chatbot") was true of every ticket. So the failure was **C: no distinction between "needs staff follow-up" and "needs someone now"**, carried by **B: priority wording**. Labels contributed only at the margin (black mold, repeated entry without notice).

## Change

Priority defined by observable risk to the student (threats or harassment aimed at them, a home they can't secure, an essential service out, losing housing now). "Normal" is everything else that still needs follow-up, and the wording of the message doesn't raise priority. Escalate exactly the urgent/high tickets. Policy: `backend/eval/README.md`, *Action labels*. Debugged on dev only: one dev run, no iteration. The two remaining dev failures could only be fixed by naming those cases' own phrases. The 22 fresh cases were run once.

## Results

| | Before | After |
|---|---|---|
| Tool-selection accuracy, all 37 | 30/37 (81.1%) | **34/37 (91.9%)** |
| — dev (15) | 10/15 (66.7%) | 12/15 (80.0%) |
| — fresh (22) | 20/22 (90.9%) | **22/22 (100%)** |
| Ticket-only cases escalated (no acceptable label escalates) | 7/12 (dev 5/5, fresh 2/7) | **2/12** (dev 2/5, fresh **0/7**) |
| Escalation cases not escalated | 0/8 (dev 0/4, fresh 0/4) | **0/8** (dev 0/4, fresh 0/4) |
| `escalate_ticket` recall | 8/8 | 8/8 |
| `escalate_ticket` precision (new scorer; old scorer) | 13/20 = 65% (9/20 = 45%) | **9/11 = 81.8%** (8/11 = 72.7%) |
| `create_ticket` recall / precision | 26/26 / 100% | 25/26 / 100% |
| Tickets set to high/urgent | 24/26 | 11/25 |
| Correct no-tool (none cases) | 11/11 | 11/11 |
| False tool-call rate | 0/11 | 0/11 |
| Hallucinated tools | 0/72 raw calls | 0/56 |
| Malformed arguments | 0/72 | 0/56 |
| Provider-rejected tool calls | 0/109 turns | **1/93 turns** |
| Model-side invalid-call rate | 0.0% | 1.8% (1/57) |
| `draft_followup_email`: draft labels drafted | 5/5 | 5/5 |
| Agent latency p50 / p95 | 2.35 s / 5.60 s | 2.47 s / 6.78 s |

The 11 escalations after are the 8 escalation-labeled cases, `tool-black-mold` and `tool-illegal-eviction-scared` (over-escalations), and `fresh-tool-draft-och-mold`, a draft label whose escalation alternative the old scorer accepted for accuracy but not for precision.

**Remaining failures after.** `tool-black-mold` and `tool-illegal-eviction-scared` (dev) were still escalated; the model's reasons were "making home unsafe" and "risk of immediate loss of housing". `tool-wellness-reach-out` (dev) got a provider-rejected generation (Groq 400 `tool_use_failed`) on its first turn, so no decision was observed. It counts as a miss, and it is the provider-rejected call in the table. The pipeline's own baseline, under the old prompt, had the same kind of rejection in 1 of 137 turns, so one occurrence is within run-to-run noise, but it is reported, not dismissed.

**Not measured by this run.** Crisis messages: the agent eval covers tool cases only. In the full pipeline, the critic escalates a crisis message only if the agent opened no ticket or opened one at high/urgent (`lib/critic.js`), so a crisis ticket opened at `normal` would not alert staff. The old prompt masked this by setting almost everything `high`. The 70-case fresh pipeline baseline (`docs/eval/pipeline-fresh-baseline/`) was measured with the old prompt and was not re-run.

## What-if: proposed label corrections (not applied)

Under the drafting rule and the ticket-level policy, six labels look inconsistent (see the final report and DEV_NOTES). With them applied, before → after: accuracy 70.3% → 89.2%, fresh 77.3% → 95.5%, ticket-only escalated 11/17 → 3/17, escalations missed 0/8 → 0/8. This is not a baseline: the corrections need review first.
