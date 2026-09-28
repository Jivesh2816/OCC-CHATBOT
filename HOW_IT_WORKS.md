# OCC Chatbot — How It Works

An Express API (`backend/`) and a React + Vite frontend (`frontend/`), deployed as two Vercel projects. All LLM calls go to Groq's `openai/gpt-oss-20b` through the Groq SDK, with no agent framework.

## Layout

```
backend/
├── server.js               # pipeline, Groq calls, all routes
├── db.js                   # async SQLite adapter: node:sqlite file, or Turso/libSQL over HTTP
├── lib/
│   ├── critic.js           # rule-based critic (pure — decides, server.js acts)
│   ├── lease.js            # Lease Checker rules + validated LLM pass
│   ├── scam.js             # Listing Scam Check signals + validated LLM pass
│   ├── bm25.js             # BM25 ranking over the official passages
│   ├── alerts.js           # Slack/Discord webhook + email alerts on escalation
│   └── cite.js             # passage ids → source links
├── faq.json                # 42 curated Q&A entries in 8 categories
├── sources/official.json   # 125 verbatim passages from official pages (generated)
├── scripts/build-sources.js
├── test/                   # node:test unit tests
└── eval/                   # eval set + runner against the live /chat pipeline
frontend/src/
├── components/Chatbot.jsx       # chat, streaming, citations, staff replies, mode tabs
├── components/AgentTrace.jsx    # live / collapsible pipeline trace
├── components/LeaseChecker.jsx
├── components/ScamChecker.jsx
├── components/StaffDashboard.jsx  # /#/staff
└── lib/api.js                   # API client + NDJSON stream reader
```

## The chat pipeline

`runPipeline()` in `server.js` serves both `POST /chat` (JSON) and `POST /chat/stream` (NDJSON). It's one code path, so the eval exercises exactly what users get.

1. **Memory.** The session's last 6 stored messages are loaded before the new one is saved.
2. **Router** (`classifyIntent`). JSON-mode LLM call over 10 intents (`housing`, `health_safety`, `rent_money`, `food`, `transit`, `bylaws`, `academic`, `social`, `urgent`, `out_of_scope`) plus a confidence score. The last two turns are included as context. It makes two attempts (temperature 0, then 0.4); if both fail, the message goes to unscoped retrieval.
3. **Critic pre-check** (`critic.preCheck`). If the student's message contains any of 25 crisis phrases, the intent becomes `urgent` regardless of the router.
4. **Retrieval and answer** (`retrievalAgent`).
   - `urgent` returns fixed crisis resources.
   - `out_of_scope` gets a general answer with no retrieval.
   - Otherwise: the top 3 FAQs are chosen by string scoring within the intent's category, and the top 3 official passages come from BM25 (housing and rent intents only, minimum score 6, with a small synonym map such as "fix" → repair/maintenance). Short follow-ups borrow the previous user message for the search.
   - The answer is streamed and cites passages as `[n]`. The prompt forbids inventing form numbers, fees, phone numbers, or deadlines that aren't in the context.
   - If Groq fails, it falls back to a direct FAQ match, then a keyword reply.
5. **Action agent** (`actionAgent`, intents `urgent` / `housing` / `health_safety` only). Function calling with three tools: `create_ticket`, `escalate_ticket`, and `draft_followup_email` (a mock Nodemailer transport). The loop runs at most 4 model turns, and each tool result is fed back so the model can chain (create → escalate).
6. **Critic post-check** (`critic.postCheck` + `applyCritic`):
   - flags low confidence (router < 0.5 or no knowledge-base match)
   - appends a legal disclaimer on 11 legal-advice phrases
   - force-escalates any `high`/`urgent` ticket the agent created but didn't escalate
   - if the message is `urgent` and no ticket exists, opens one and escalates it

   Every decision is written to `critic_log`, fired or not.

Stream events, in order: `session` → `step` (running / done, with timing and details) for each stage → `token` chunks of the answer → `done` with the full payload. The final text in `done` replaces the streamed text, because the critic may have edited it.

## Lease Checker (`lib/lease.js`)

The lease is split into clauses (lines, then sentences). There are 10 rules, each with a severity (`void` or `check`), an explanation paraphrasing the official guidance, and the ids of the passages that back it.

- **Rules pass:** regexes per rule, with exclusions for lawful wording (e.g. "damage caused by the tenant", "in an emergency", "without the landlord's consent").
- **Model pass:** the model sees numbered clauses (up to about 14k characters) plus the rule catalog, and returns only `{clause, rule}` pairs. Unknown rules and out-of-range clause numbers are dropped, so the model can't invent a quote or a rule.
- Findings are merged per clause and rule, and each one records which detector found it (`rules`, `model`, or both).

PDFs are sent base64-encoded and read with `unpdf`. A scanned PDF with no text layer returns a clear error.

## Listing Scam Check (`lib/scam.js`)

Eight warning signs taken from UW Special Constable Service's rental-fraud page, each with a weight: untraceable payment, pay before viewing, overseas landlord, overpayment, urgency, banking info up front, illegal fees, and a below-market price. The price check compares the listed price with UW Off-Campus Housing's published estimate for the matching unit type (flagged below 60%). Model signals are kept only if their quote actually appears in the listing. Risk is **high** if any weight-3 sign is present or the total is ≥ 4, **medium** if the total is ≥ 2, otherwise **low**.

## Official sources

`npm run build:sources` fetches 10 pages (UW Off-Campus Housing, Government of Ontario rental pages, UW Special Constable Service), keeps the `<main>` content, and splits it by heading into passages of at most 1,100 characters. Each passage records its URL, heading, and fetch date. The output is committed, so production never scrapes at request time.

## Staff alerts (`lib/alerts.js`)

When a ticket is escalated for the first time, by the action agent or the critic, the backend alerts staff through every configured channel: a Slack or Discord webhook (`STAFF_ALERT_WEBHOOK_URL`) and/or email (`SMTP_URL` + `STAFF_ALERT_EMAIL`).

- **Content:** the alert contains the ticket id, category, priority, who escalated it, and a dashboard link. It never includes the student's message or the agent-written escalation reason, which usually paraphrases the message, so crisis text never lands in a chat channel or inbox.
- **Timing:** alerts are awaited, with a 4-second timeout, before the response is sent. Serverless functions can be frozen once they respond, so fire-and-forget could silently drop an alert. A failed channel is logged and never breaks the chat.
- **Crisis reply wording:** the reply promises that the support team has been notified only when at least one alert channel is configured. Otherwise it points only to the phone lines.

## Rate limits

`express-rate-limit`, per client IP, on everything that calls the model. The defaults are env-tunable:

| Endpoint | Per minute | Per hour |
|---|---|---|
| `/chat`, `/chat/stream` | 12 | 100 |
| `/lease/check`, `/lease/escalate`, `/listing/check` | 5 | 30 |
| `/staff/*` (slows token guessing) | 60 | — |

On Vercel, `trust proxy` is enabled so `req.ip` is the real client from `X-Forwarded-For`. It stays off locally, where that header could be spoofed. The counters live in memory, which on serverless means per instance, so this caps abuse rather than enforcing an exact global quota.

The underlying constraint is Groq's free tier: **8,000 tokens per minute** for `gpt-oss-20b`, shared by all users. A chat message costs about 3 calls (router, answer, and action agent), so the deployment realistically serves only a few messages per minute in total. When Groq returns 429, retrieval falls back to the best-ranked FAQ answer and the UI says the model was unavailable.

## Evaluation (`eval/`)

`npm run eval [chat|lease|scam]` calls the running backend over HTTP. The default delays keep it under the server's own rate limits; set `EVAL_CHAT_DELAY_MS` and `EVAL_TOOL_DELAY_MS` lower only against a server started with higher `RATE_LIMIT_*` values.

- **chat** (`eval-set.json`, 34 cases): router intent, match type, critic flags, whether the answer cites an official passage, whether the expected passage was retrieved, multi-turn follow-ups (`setup` turns sent first in the same session), and that urgent messages end with an escalated ticket.
- **lease** (`lease-set.json`, 13 leases): precision and recall over planted void clauses, scored twice, once for rules plus model and once for rules alone, to show what the model pass adds. Any unexpected `void` flag counts as a false positive.
- **scam** (`scam-set.json`, 8 listings): risk-level accuracy, the share of scams flagged, and the share of legitimate listings marked low.

Results go to `eval/eval-results.json` (git-ignored). The README lists the latest numbers.

## Data model

| Table | Holds |
|---|---|
| `sessions` | Anonymous session ids (UUID in the browser's `sessionStorage`) |
| `messages` | `user` / `bot` / `staff` messages per session |
| `tickets` | Category, priority, status (`open`, `escalated`, `in_progress`, `resolved`), escalation reason, drafted emails |
| `ticket_replies` | Staff replies (also mirrored into `messages` so the student sees them) |
| `critic_log` | Every critic decision: intent, confidence, flags, reasoning |

## API

| Route | Access | Purpose |
|---|---|---|
| `POST /chat` · `POST /chat/stream` | public | Chat pipeline (JSON / NDJSON) |
| `GET /topics` | public | FAQ topic counts, passage count |
| `GET /history?sessionId=` · `DELETE /history` | session | A session's messages |
| `GET /session/:id/tickets` | session | That session's tickets and replies |
| `GET /session/:id/updates?after=` | session | Staff replies newer than a message id (polled every 8s) |
| `POST /lease/check` · `POST /lease/escalate` | public | Lease analysis; open a `lease_review` ticket |
| `POST /listing/check` | public | Scam analysis |
| `GET /staff/tickets` · `GET /staff/tickets/:id` | staff token | Queue; ticket with conversation and critic log |
| `POST /staff/tickets/:id/reply` · `PATCH /staff/tickets/:id` | staff token | Reply; change status |
| `GET /staff/critic-log` | staff token | Last 500 critic decisions |

"Session" routes are guarded only by the session id being an unguessable UUID held by that browser tab. Staff routes need `Authorization: Bearer $STAFF_TOKEN`; without `STAFF_TOKEN` set they return 503 rather than being open, because tickets and the critic log contain students' raw messages.

## Design decisions

- **The critic is rules, not a second LLM.** A safety net built on another probabilistic model is a weaker safety net. Its rules are pure functions with unit tests.
- **Constrain the model, then verify it.** In the lease and scam checkers, the LLM chooses from a fixed catalog, and its output is checked against the input: clause numbers must exist, and quotes must appear verbatim. The model adds recall; the rules and validation keep precision and citations honest.
- **Verbatim sources over model memory.** Explanations link to stored official text rather than relying on what the model recalls about tenancy law.
- **Hosted SQLite for serverless.** Vercel instances don't share a disk, so a staff queue needs shared storage. `db.js` keeps the same SQL and switches between a local file and Turso with one environment variable.
