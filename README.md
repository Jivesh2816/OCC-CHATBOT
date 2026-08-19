# OCC Chatbot

Answers housing, rent, transit, health, food, and campus-bylaw questions for University of Waterloo students living off campus — grounded in a 42-entry FAQ set, not a model freeform-guessing.

**Live demo:** _add your deployed frontend URL here_ · **Backend API:** [occ-chatbot.vercel.app](https://occ-chatbot.vercel.app)

![Node](https://img.shields.io/badge/Node-Express-000?logo=node.js&logoColor=white) ![React](https://img.shields.io/badge/React_18-Vite-149eca?logo=react&logoColor=white) ![Groq](https://img.shields.io/badge/Groq-GPT--OSS_20B-orange) ![Vercel](https://img.shields.io/badge/Deploy-Vercel-black?logo=vercel&logoColor=white)

## What it looks like

| Desktop — welcome | Desktop — answer with provenance tag |
|---|---|
| ![Desktop welcome view](docs/screenshots/desktop-welcome.png) | ![Desktop chat view](docs/screenshots/desktop-chat.png) |

| Mobile — welcome | Mobile — Groq-down fallback, disclosed |
|---|---|
| ![Mobile welcome view](docs/screenshots/mobile-welcome.png) | ![Mobile chat view](docs/screenshots/mobile-chat.png) |

The tag under every answer (`OCC · Housing & Leases`) names the real FAQ category it came from. When Groq is unreachable, the UI says so — the right screenshot above shows that state, captured in local dev without an API key.

## How it works

```mermaid
flowchart LR
    U[User message] --> R[findRelevantFAQs\nscore all 42 entries]
    R --> G[Groq · GPT-OSS 20B\nanswers grounded in top-3 FAQ context]
    G -->|succeeds, FAQ matched| T1[Tag: real category]
    G -->|succeeds, no FAQ matched| T2[Tag: fallback\nno alert]
    G -->|Groq unreachable| S[searchFAQ\ndirect/fuzzy match]
    S -->|found| T3[Tag: real category\n+ Groq-down alert]
    S -->|not found| I[getIntelligentResponse\nkeyword fallback]
    I --> T4[Tag: fallback\n+ Groq-down alert]
```

`POST /chat` returns `category` and `matchType` alongside the answer, so the frontend can render an honest tag instead of implying every reply is a fresh generation.

Full write-up: [HOW_IT_WORKS.md](HOW_IT_WORKS.md).

## Tech stack

Express · Groq SDK (GPT-OSS 20B) · React 18 + Vite · plain CSS (no framework) · Vercel (two projects: `backend/`, `frontend/`)

## Running locally

```bash
cd backend && npm install && npm run dev     # nodemon, http://localhost:5000 — needs GROQ_API_KEY in backend/.env
cd frontend && npm install && npm run dev    # Vite, http://localhost:3000, proxies /api to :5000
```

## Scope — v1 decisions, not gaps

- **42 FAQ entries.** Small on purpose: everything in it is accurate, not padded to look bigger.
- **In-memory chat history.** No database — history resets on every deploy or restart.
- **No auth.** Fully anonymous, stateless per session.

## Repo layout

```
Chatbot/
├── backend/
│   ├── server.js      # FAQ matching, Groq calls, all routes
│   ├── faq.json        # 42 Q&A entries, each tagged with a category
│   └── vercel.json
└── frontend/
    ├── src/components/Chatbot.jsx   # sidebar + chat UI
    ├── src/components/Chatbot.css
    └── public/                      # favicon, OG image
```
