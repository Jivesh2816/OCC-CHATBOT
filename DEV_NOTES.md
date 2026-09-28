# Dev Notes

Running log of implementation decisions and non-obvious context — the "why," not the "what" (the code and commit messages already cover what changed).

## Agent pipeline (backend/server.js)

`HOW_IT_WORKS.md` has the full current reference; this section keeps the reasoning behind each stage.

Four stages, run in order on every `POST /chat`:

1. **Router** (`classifyIntent`) — Groq classifies intent + confidence before any retrieval happens. Two-attempt retry: attempt 1 at temperature 0 (deterministic), attempt 2 at 0.4 if the first comes back empty — retrying a temp-0 call with the same input just reproduces the same failure, so the retry actually needs a different generation path.
2. **Retrieval** (`retrievalAgent`) — FAQ search scoped to the router's intent category, then Groq generates an answer grounded in that context. Falls back to direct FAQ match, then a keyword responder, if Groq fails.
3. **Action agent** (`actionAgent`) — real function-calling (`create_ticket` / `draft_followup_email` / `escalate_ticket`), only runs for `urgent` / `housing` / `health_safety` intents. Bounded 4-step tool loop; the model decides for itself whether a message is a genuine incident vs. a general question.
4. **Critic** (`lib/critic.js`: `preCheck` / `postCheck`, applied by `applyCritic` in `server.js`) — deliberately rule-based, not another LLM call (a safety net backed by a second probabilistic model is a weaker safety net). Runs twice: a pre-check against a fixed safety-phrase list (can override the router's own classification straight to `urgent`), and a post-check on the assembled response (appends a legal disclaimer for landlord/legal-sounding phrasing, force-escalates a high/urgent ticket the action agent created but didn't escalate).

Every critic decision — fired or not — is logged to SQLite (`critic_log` table) as eval material.

Persistence (Stage 5, `db.js`) and the eval harness (Stage 6, `backend/eval/`) existed locally but uncommitted until 2026-08-26 — see below.

## 2026-08-26 — Frontend redesign + backend fixes

**Fixed:** `server.js` had a stray `okay` prepended to line 1 (`okayconst express = require(...)`) — a SyntaxError that crashed the backend on every boot. One-line fix; unrelated to everything else below, just found it while trying to test live.

**Frontend rebuilt from scratch, three rounds, each shaped by live feedback rather than guessed upfront:**

1. First pass — sidebar (topics + live ticket feed) + chat pane, dark forest-green theme, Vanta.NET wireframe background, GSAP entrance/message animations, hand-rolled shadcn-style primitives (`class-variance-authority` + Tailwind v4 — not the actual shadcn CLI, since this is a JS, not TS, project). **Rejected** — read as a dashboard, not a chatbot.
2. Second pass — dropped the sidebar for a centered ChatGPT/Claude-style column, clean light theme, tickets moved into an on-demand slide-over ("Activity" button in the header) instead of always-visible chrome. **Approved as a layout**, but called "too normal."
3. Third pass, same layout — added an actual brand identity: warm amber→coral gradient used consistently (logo mark, assistant avatar, send button, focus glow), a Fraunces serif italic accent word in the headline, a small Vanta.GLOBE wireframe as a hero accent instead of a full-bleed pattern, soft animated gradient blobs behind the greeting, iconized topic cards (lucide icons + colored top edge instead of flat tinted fill), and a faint film-grain overlay on `body::after`. **Approved.**
4. Follow-up — swapped the flat white page background for an ambient multi-layer radial-gradient (peach/coral corners fading to warm cream, `background-attachment: fixed`); cards/header/composer stayed white so they read as elevated rather than blending into the page.

**Layout bug caught along the way:** the hero card had `overflow-hidden` and was a flex child inside a `justify-center` container with no `shrink-0`. `overflow-hidden` resets a flex item's automatic minimum size to `0`, so when the greeting's content didn't fit the viewport, flexbox silently shrank the hero box instead of letting the page scroll, clipping the subtitle text at the rounded corner. Fixed by adding `shrink-0` to the three welcome-screen sections and switching the outer container from `h-full` to `min-h-full` so it can grow instead of being squeezed.

Also replaced raw markdown text — bot answers were dumping literal `**bold**`, tables, and `<br>` tags straight to the screen — with `react-markdown` + `remark-gfm` + Tailwind Typography.

**Verified the agent pipeline live**, not just read the code: sent a real housing-dispute message to the deployed backend. Router classified `housing` at 95% confidence; action agent created a ticket at `priority: high` but didn't escalate it; critic caught that and force-escalated it, and separately flagged the response for legal-advice-like phrasing. Confirmed via `/critic-log`.

**"Groq not available" report on the live site** — traced to Groq's free-tier rate limit, most likely tripped by the burst of test messages sent during the verification above (each chat message costs up to 3 sequential Groq calls: router + retrieval + action agent). Confirmed the key itself is valid (direct API call succeeded outside the app), both Vercel projects (`occ-chatbot` backend, `occ-chatbot-36q6` frontend) redeployed cleanly off the day's push, and a full browser-driven run against the live site completed in ~2.1s with no error banner.

## 2026-09-28 — Cited sources, memory, streaming trace, lease/scam checkers, staff queue

**Official sources, not model memory.** `scripts/build-sources.js` scrapes 10 official pages (UW Off-Campus Housing, ontario.ca rental pages, UW Special Constable Service) into 125 verbatim passages, split by heading. Every lease rule and scam signal cites passage ids, and a unit test fails if a cited id disappears after a re-scrape.

**Retrieval is BM25, deliberately not embeddings.** Groq has no embeddings endpoint, and adding a second provider for a 125-passage corpus wasn't worth it. Raw BM25 had two failure modes, both fixed and covered by ranking tests: (1) section numbers in headings ("10. Smoking") matched numbers in queries ("raise rent by 10%"), so bare numeric tokens are dropped; (2) students and official pages use different words ("fix my heater" vs. "maintenance and repairs"), so there's a small explicit synonym map. Official passages are only searched for housing/rent intents, since that's all the corpus covers; otherwise "grocery discounts" matched "7. Rent discounts".

**gpt-oss cites as 【1】**, not `[1]`, so citation detection silently failed until normalized (backend for the stored text, frontend for the live stream). The model also invented an LTB form number in testing, so the answer prompt now forbids form numbers, fees, phone numbers, and deadlines that aren't in the context.

**Lease/scam checkers: the model can only point, not write.** The model returns clause numbers and rule ids (lease) or quotes that must appear verbatim in the listing (scam); anything else is dropped. Risk levels are computed from validated signals. In live testing the model caught phrasings the regexes missed ("guests may stay no more than two nights", "inspect … at any time", "shares the kitchen"); the last two became regex fixes too.

**Critic gap closed.** The critic previously force-escalated only tickets the action agent had created. An urgent message where the agent created nothing reached no human, so the critic now opens and escalates a ticket itself. The crisis reply no longer promises human follow-up is "coming in a later stage".

**Persistence for serverless.** A staff queue on Vercel needs storage shared across instances, and `/tmp` SQLite isn't. `db.js` became an async adapter: `node:sqlite` locally, Turso/libSQL over HTTP when `TURSO_DATABASE_URL` is set, with the same SQL for both. `/tickets` and `/critic-log` were public and returned every student's raw messages (including crisis text); they're now behind `STAFF_TOKEN`, and students only see their own session's tickets.

**Streaming.** `/chat/stream` emits NDJSON step events and answer tokens from the same `runPipeline()` that `/chat` uses. Whether Vercel's Node runtime flushes the stream incrementally is untested; the client falls back to `/chat` if the stream fails before any event arrives.

**Verified locally**, not just built: 30 unit tests pass, and a Playwright run drove streaming, citations, follow-up memory, reload-restore, lease check with PDF upload and send-to-advisor, scam check, the mobile layout, and a staff reply appearing in the student's chat, with no console errors.

## 2026-09-28 (later) — Staff alerts, rate limits, expanded eval

**A queue nobody watches isn't a handoff.** Escalations now alert staff by Slack/Discord webhook or email. The first live test caught a privacy leak in my own design: the alert included the escalation *reason*, which the action agent writes, and it read "Student reports stalking…", a paraphrase of the crisis message. Alerts now carry only ticket metadata and who escalated it. The crisis reply promises human follow-up only when an alert channel is configured; otherwise it points only to the phone lines.

**Rate limits exist because of Groq's free tier, not just abuse.** The eval hit Groq's 8,000 tokens-per-minute cap even at a gentle pace. At ~3 calls per chat message, the whole deployment realistically serves a few messages per minute, so one person scripting requests could take it down for everyone. Per-IP limits cap that; they're in-memory per serverless instance, so they're a brake, not an exact quota.

**The expanded eval found real bugs, not just numbers.** (1) The lease splitter dropped clauses under 12 characters, so "No pets." was invisible to both detectors. (2) When Groq hit its rate limit, retrieval fell back to a generic keyword reply even though it had already ranked three relevant FAQs; it now serves the top-ranked FAQ. (3) "How do I get out of my lease early?" retrieved nothing: the right passage ranked first but scored under the cutoff, because "get out of" carries no signal. Phrase synonyms fixed it without lowering the threshold, which would have let noise back in. (4) The scam checker's "pay before viewing" rule fired on any "before … viewing", even with no money involved.

**Not tuned away:** two ambiguous intent labels, and one banking-info scam listing scored medium, not high. Changing weights until an 8-case set passes would be overfitting; the README reports them as failures.

**Escaping trap, for next time:** patching files through `node -e "…"` or unquoted heredocs silently turned `\b` into backspace bytes and `\n` into real newlines inside regexes and strings, three times this session. Anything with backslashes goes through the Edit tool or a quoted heredoc (`<<'EOF'`), and a control-character scan over the tracked files now comes back clean.
