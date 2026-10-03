# Evaluation evidence

Reports behind every number in the main README and in `docs/RESUME_EVIDENCE.md`. Each folder holds the `eval-report.md` the harness produced (and `eval-results.json` for live runs, whose model outputs can't be regenerated for free). Method: [`backend/eval/README.md`](../../backend/eval/README.md).

All runs: 2026-09-30, Node 22.18, model `openai/gpt-oss-120b` on Groq (live runs only), dataset v1. "Code" is the state of the working tree at the time; the changes between runs are listed in order.

## Change log the runs bracket

1. **Baseline**: commit `a7ba9f2` plus refactors that don't change behaviour (FAQ ids, `app.js`/`server.js` split, scored retrieval exports).
2. **Crisis rules**: match-level vetoes (bug fix), information-seeking vetoes, precise new patterns; three over-broad pattern families added and then removed after the fresh split showed them misfiring.
3. **FAQ re-tag**: three food FAQs moved from "Rent & Money" to "Food & Essentials".
4. **Housing-emergency retrieval**: official vocabulary added to the query when the crisis detector flags a housing emergency.
5. Unrelated to metrics: fallback-regex fix, structured logging, request ids, critic log no longer stores message text.

## Runs

| Folder | Mode | Split | Code | Command |
|---|---|---|---|---|
| `offline-dev-before` | offline | dev (247) | 1 | `node eval/run.js --mode offline --split dev --label before` |
| `offline-dev-after-crisis` | offline | dev | 1–2 | `… --split dev --label after-crisis` |
| `offline-dev-after-faq-retag` | offline | dev | 1–3 | `… --split dev --label after-faq-retag` |
| `offline-dev-after-hemerg-retrieval` | offline | dev | 1–4 | `… --split dev --label after-hemerg-retrieval` |
| `offline-targeted-before` | offline | targeted (44) | 1 | `… --split targeted --label before` |
| `offline-targeted-final` | offline | targeted | 1–4 | `… --split targeted` |
| `offline-fresh-original-rules` | offline | fresh (28) | 1 with original `lib/crisis.js` | `… --split fresh` (original rules) |
| `offline-fresh-frozen-expansion` | offline | fresh | 2 before the three families were removed | `… --split fresh` (one shot, before any change informed by it) |
| `offline-fresh-final` | offline | fresh | 1–4 | `… --split fresh` |
| `offline-all-final` | offline | all (321) | 1–5 | `npm run eval` (the CI baseline) |
| `router-baseline` | router (live) | dev (247) | 1 | `node eval/run.js --mode router --label baseline` |
| `router-baseline-replay-current-code` | router (replay) | same 247 | 1–5 | `node eval/run.js --mode router --replay <router-baseline> --ids <its 247 ids>` |
| `router-additions` | router (live) | 73 of the 74 cases added after the baseline started | 1–5 | `node eval/run.js --mode router --ids <73 ids> --label additions` |
| `router-additions-2` | router (live) | the 1 case the list above missed | 1–5 | `node eval/run.js --mode router --ids rent-reasonable-amount --label additions-2` |
| `router-all-final` | router (replay) | all (321) | 1–5 | `node eval/run.js --mode router --replay <router-baseline>,<router-additions>,<router-additions-2> --label all-final` |
| `router-fresh-final` | router (replay) | fresh (28) | 1–5 | same, with `--split fresh --label final` |
| `pipeline-sample` | pipeline (live) | 4 hand-picked cases | 1–5 | `node eval/run.js --mode pipeline --ids tool-heater-ignored-emails,crisis-end-my-life,housing-entry-notice,sec-injected-priority-email --label sample` |
| `experiment-dense-retrieval` | A/B | all labeled (217) | 1–4 | `cd backend/eval/experiments && npm install && npm run dense-retrieval` |

## Round 2 (same day, later): trust boundary, tool calling, cut-offs

Dataset v2: 387 cases (66 added: 22 tool-calling, 22 trust-boundary, 22 "no answer"). Changes: router and action agent receive student text as JSON data under an explicit trust rule (router fingerprint `17a62ecd151a` → `8be7fa335cc5`); `retrieve()` accepts cut-off overrides for sweeps only. Every folder below is new; round-1 folders above are unchanged.

| Folder | Mode | Cases | Router prompt | What it shows |
|---|---|---|---|---|
| `router-trust-before` / `router-trust-after` | router (live) | 13 trust cases written before the fix (+1 dev) | old / new | injection attacks escalated 3/7 → 0/7; genuine reports 6/6 → 6/6 |
| `router-trust-fresh-before` / `router-trust-fresh-after` | router (live) | 10 trust cases written after the fix was frozen | old / new | attacks escalated 2/5 → 1/5; genuine reports 4/5 → 4/5 |
| `router-safety-newprompt` | router (live) | 135 safety-category cases, all splits | new | the input to the prompt comparison below |
| `experiment-router-prompt` | analysis | same 135 cases | old vs new | `node eval/experiments/compare-router-prompts.js <old runs> <new run>`: recall unchanged per split, false escalations 11 → 6 |
| `experiment-threshold-sweep` | offline | dev + fresh | n/a | `node eval/experiments/threshold-sweep.js`: no cut-off pair keeps false matches ≤ 10%; current cut-offs kept |
| `experiment-dense-retrieval-v2` | offline A/B | 236 labeled cases | n/a | ranking results reproduce round 1; abstention AUC: BM25 0.86, dense 0.78–0.82 |
| `offline-all-v2` | offline | all 387 | n/a | the current CI baseline (`npm run eval`) |
| `agent-tools-partial` | agent (live, cached) | **6 of 37** tool cases | n/a | **Superseded by `agent-baseline`; do not cite.** Stopped by the daily token quota, and one of its 6 cases (`tool-wellness-reach-out`) is invalid: a 429 interrupted the agent's tool loop after turn 1 and a harness bug (fixed in `928c6c5`) cached the partial result as complete (DEV_NOTES, 2026-10-02). |

**`pipeline-sample` caveats.** Four cases is a plumbing check, not a benchmark: don't quote its accuracy figures. Its end-to-end and per-stage timings are also **invalid**. They were recorded before a harness fix, and they include the harness's own rate-limit pacing waits (the pacer sleeps inside the model call). The per-call LLM latencies and token counts in it are valid: those are timed after the pacer.

Replays reuse the recorded router decisions and re-run everything deterministic with the current code; they refuse to run if the router prompt or model changed (fingerprint `17a62ecd151a`).

## Round 3 (2026-10-02/03): frozen baselines

Measured before any change informed by them. Both folders include the exact cache the run read (`cache/*.jsonl`), so the reports can be regenerated offline, with no API calls, from the code at commit `928c6c5` (agent and pipeline code identical to `12a7d67`):

`EVAL_CACHE_DIR=../docs/eval/<folder>/cache node eval/run.js <args> --cached-only --out <dir>` (from `backend/`)

| Folder | Mode | Cases | Command | Headline |
|---|---|---|---|---|
| `pipeline-fresh-baseline` | pipeline (live) | fresh, 70 of 70 | `npm run eval:pipeline -- --split fresh --resume` | escalation recall 95.0%, precision 76.0%, FPR 17.6% (hard negatives 38.5%); agent tool selection 92.0% (n=50); end-to-end p50 3.6 s / p95 14.4 s |
| `agent-baseline` | agent (live) | tool_incident + tool_no_action, 37 of 37 (dev 15, fresh 22) | `npm run eval:agent -- --category tool_incident,tool_no_action --resume` | tool-selection accuracy 81.1% (dev 66.7%, fresh 90.9%); no-tool 11/11; escalate precision 45%; ticket-only cases escalated 6/11 (dev 5/5, fresh 1/6) |

The agent baseline's 37 cases come from two quota windows: 5 cached from 2026-09-30, 32 run 2026-10-03 after the two invalidated entries were removed (DEV_NOTES, 2026-10-02).
