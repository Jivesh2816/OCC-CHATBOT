# OCC Chatbot — How It Works

## Overview

OCC Chatbot answers off-campus-living questions for University of Waterloo students — housing, rent, transit, health, food, and campus bylaws. It's a two-part app: an Express API (`backend/`) and a React + Vite frontend (`frontend/`), deployed as two separate Vercel projects.

## Architecture

```
Chatbot/
├── backend/
│   ├── server.js      # All chat logic: FAQ matching, Groq calls, routes
│   ├── faq.json        # Knowledge base — 42 Q&A entries, each tagged with a category
│   └── vercel.json
└── frontend/
    ├── src/components/Chatbot.jsx   # Sidebar + chat UI, all app state
    ├── src/components/Chatbot.css
    └── public/                      # favicon, OG image
```

## Knowledge base

`faq.json` is a flat array of 42 entries:

```json
{
  "question": "My landlord won't fix maintenance issues",
  "category": "Housing & Leases",
  "answer": "..."
}
```

Each entry belongs to one of 8 categories. Six are promoted as nav topics in the UI (sidebar on desktop, welcome tiles on mobile):

| Topic | Count |
|---|---|
| Housing & Leases | 10 |
| Health & Safety | 7 |
| Rent & Money | 4 |
| Food & Essentials | 4 |
| Getting Around | 4 |
| Neighbours & Bylaws | 4 |

Two more categories — **Academic** (5) and **Clubs & Social** (4) — exist in the data and are still matched and correctly tagged in answers, but aren't given a dedicated nav entry point; they're reachable by typing a question directly.

## Answering a question

```
POST /chat  { message }
     │
     ▼
findRelevantFAQs()  — score all 42 entries, take the top 3 as context
     │
     ▼
generateWithGroq()  — GPT-OSS 20B answers, grounded in that FAQ context
     │
     ├─ succeeds, and a relevant FAQ was found → matchType: "faq", category from the top match
     ├─ succeeds, but no FAQ scored above 0    → matchType: "fallback" (general knowledge, no FAQ backing)
     └─ Groq call fails                        → searchFAQ() direct match, else getIntelligentResponse() keyword fallback
```

The response includes `category` and `matchType` so the frontend can render the provenance tag under each answer — a real FAQ category (e.g. `OCC · Housing & Leases`) versus a fallback match, without claiming an AI-generated answer where there wasn't one.

## API

| Route | Purpose |
|---|---|
| `POST /chat` | Main endpoint. `{ message }` → `{ response, category, matchType, source, history }` |
| `GET /topics` | Live topic list with per-category counts, for the sidebar |
| `GET /history` / `DELETE /history` | In-memory chat history (resets on restart — no database) |

There is no `/ask` route — an earlier confidence-scoring endpoint that the frontend never called was removed.

## Frontend

`Chatbot.jsx` is a single component with two views:

- **Welcome** (no messages yet): a hero prompt, a grid of topic tiles, and a few real example questions.
- **Chat**: message thread. Every bot message carries a provenance tag, and — if Groq was unreachable for that request — an inline note saying so explicitly rather than presenting a keyword-matched answer as a generated one.

Layout is a persistent sidebar + chat pane on screens ≥900px, and a single-column view with a compact header below that.

## Environment

Backend needs `GROQ_API_KEY` (Groq API) in `backend/.env` locally and in the backend Vercel project's environment variables. No other AI provider is used — `openai` and `@google/generative-ai` were leftover dependencies from an earlier Gemini-based iteration and have been removed.

## Known limitations (v1 scope, not oversights)

- 42 FAQ entries — not comprehensive, but everything in it is accurate and current as of the last edit.
- Chat history is a plain in-memory array — no database, resets on every deploy or restart.
- No auth or accounts — fully anonymous, stateless per session.
