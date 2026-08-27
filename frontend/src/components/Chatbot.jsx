import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import axios from 'axios'
import gsap from 'gsap'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Plus, SendHorizontal, Sparkles, ListChecks, ArrowUpRight, Ticket, Home, Wallet, TrainFront, HeartPulse, ShoppingBasket, Users2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Textarea } from '@/components/ui/textarea'
import { Sheet, SheetTrigger, SheetContent } from '@/components/ui/sheet'
import VantaGlobe from '@/components/VantaGlobe'

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? '/api'
    : 'https://occ-chatbot.vercel.app')

// The 6 topics promoted as example prompts on the empty screen. Counts are
// fetched live from /topics and fall back to these known-good numbers.
const NAV_TOPICS = [
  { name: 'Housing & Leases', hint: 'Signing, subletting, disputes', hue: 250, icon: Home, fallbackCount: 10, starter: "My landlord won't fix maintenance issues" },
  { name: 'Rent & Money', hint: 'Deposits, utilities, discounts', hue: 150, icon: Wallet, fallbackCount: 4, starter: 'What should I know about off-campus utilities?' },
  { name: 'Getting Around', hint: 'ION, GRT, U-Pass', hue: 285, icon: TrainFront, fallbackCount: 4, starter: 'How do I get around campus and the city?' },
  { name: 'Health & Safety', hint: 'Clinics, mental health, emergencies', hue: 200, icon: HeartPulse, fallbackCount: 7, starter: 'What health services are available on campus?' },
  { name: 'Food & Essentials', hint: 'Groceries, food support', hue: 30, icon: ShoppingBasket, fallbackCount: 4, starter: 'I need food support - where can I get help?' },
  { name: 'Neighbours & Bylaws', hint: 'Noise, waste, parking', hue: 105, icon: Users2, fallbackCount: 4, starter: 'What campus and municipal rules should I know?' }
]

const POPULAR_QUESTIONS = [
  "My landlord won't fix maintenance issues",
  'U-Pass not working on bus/ION',
  'What grocery stores offer student discounts?',
  'Mental health resources'
]

const TOTAL_FAQS_FALLBACK = 42

// Stage 5: the backend now persists messages/tickets per session in SQLite.
// sessionStorage (not localStorage) keeps that identity scoped to this tab,
// matching the app's no-auth, anonymous-per-session model.
const SESSION_STORAGE_KEY = 'occ_session_id'

const dot = (hue) => `oklch(0.62 0.15 ${hue})`
const wash = (hue) => `oklch(0.94 0.035 ${hue})`

function formatTime(date) {
  return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// The model occasionally emits literal "<br>" text instead of a markdown
// line break — react-markdown renders raw HTML as inert text by default, so
// swap it for a real newline before handing content to ReactMarkdown.
function cleanMarkdown(content) {
  return content.replace(/<br\s*\/?>/gi, '\n')
}

// One line summarizing what the agent pipeline actually did for this message
// — the router's classification, any critic flags that fired, and any real
// action-agent side effects (ticket/escalation/email). Without this, the
// whole backend rebuild is invisible in the UI.
function traceSummary(m) {
  const parts = [`intent: ${m.intent || 'none'}${m.routerConfidence != null ? ` (${Math.round(m.routerConfidence * 100)}%)` : ''}`]
  const firedFlags = Object.entries(m.criticFlags || {}).filter(([, fired]) => fired).map(([name]) => name)
  if (firedFlags.length) parts.push(`critic: ${firedFlags.join(', ')}`)
  if (m.actions?.length) parts.push(`actions: ${m.actions.map(a => a.tool.replace(/_/g, ' ')).join(', ')}`)
  return parts.join('   ·   ')
}

function ActivityPanel({ tickets, totalFAQs }) {
  return (
    <div className="flex h-full flex-col gap-5 p-5">
      <div className="flex items-center gap-2 text-[15px] font-semibold">
        <ListChecks className="h-4 w-4 text-primary" />
        Agent Activity
      </div>
      {tickets.length === 0 && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          No tickets yet — a housing or safety issue that needs real follow-up creates one here.
        </p>
      )}
      {tickets.length > 0 && (
        <div className="flex flex-col gap-2 overflow-y-auto">
          {tickets.map(t => (
            <div key={t.id} className="flex flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 font-mono text-[11.5px] text-foreground/85">
                  <Ticket className="h-3 w-3 text-muted-foreground" />
                  {t.id}
                </span>
                <Badge variant={t.escalated ? 'destructive' : 'default'}>
                  {t.escalated ? 'Escalated' : t.status}
                </Badge>
              </div>
              <span className="text-[11.5px] text-muted-foreground">{t.category} · {t.priority}</span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-4 text-[12px] leading-relaxed text-muted-foreground">
        <p>Can&rsquo;t find it here? WUSA and the UW Off-Campus Housing Office have the full details — this assistant only draws from a {totalFAQs}-entry FAQ set.</p>
        <a href="https://wusa.ca" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
          wusa.ca <ArrowUpRight className="h-3 w-3" />
        </a>
      </div>
    </div>
  )
}

const Chatbot = () => {
  const [messages, setMessages] = useState([])
  const [sessionId, setSessionId] = useState(() => {
    try { return sessionStorage.getItem(SESSION_STORAGE_KEY) || null } catch { return null }
  })
  const [isLoading, setIsLoading] = useState(false)
  const [textInput, setTextInput] = useState('')
  const [topics, setTopics] = useState(NAV_TOPICS.map(t => ({ name: t.name, count: t.fallbackCount })))
  const [totalFAQs, setTotalFAQs] = useState(TOTAL_FAQS_FALLBACK)
  const [tickets, setTickets] = useState([])
  const [activityOpen, setActivityOpen] = useState(false)
  const bodyEndRef = useRef(null)
  const lastBotRowRef = useRef(null)
  const inputRef = useRef(null)
  const welcomeRef = useRef(null)
  const rowRefs = useRef(new Map())
  const seenRows = useRef(new Set())

  const isWelcome = messages.length === 0

  useEffect(() => {
    let cancelled = false
    axios.get(`${API_BASE_URL}/topics`).then(res => {
      if (cancelled || !res.data) return
      if (Array.isArray(res.data.topics)) setTopics(res.data.topics)
      if (res.data.totalFAQs) setTotalFAQs(res.data.totalFAQs)
    }).catch(() => {
      // keep fallback counts — the UI still works, just not live
    })
    return () => { cancelled = true }
  }, [])

  // Real side effects from the action agent (Stage 3) otherwise only exist
  // in SQLite — this is what makes them visible without opening devtools.
  const refreshTickets = () => {
    axios.get(`${API_BASE_URL}/tickets`).then(res => {
      if (Array.isArray(res.data?.tickets)) setTickets(res.data.tickets)
    }).catch(() => { /* Activity panel just stays empty */ })
  }

  useEffect(() => { refreshTickets() }, [])

  useEffect(() => {
    const last = messages[messages.length - 1]
    // A finished bot answer scrolls its own top (tag + start of the reply) into
    // view instead of jumping straight to the bottom, so it isn't hidden above
    // the fold on short viewports. Everything else chases the bottom.
    if (!isLoading && last?.role === 'bot' && lastBotRowRef.current) {
      lastBotRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' })
    } else {
      bodyEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, isLoading])

  // Animate each newly-appended row in with GSAP instead of a static CSS
  // keyframe — lets bot rows and user rows ease in slightly differently.
  useLayoutEffect(() => {
    messages.forEach((m, i) => {
      if (seenRows.current.has(i)) return
      const el = rowRefs.current.get(i)
      if (!el) return
      seenRows.current.add(i)
      gsap.fromTo(
        el,
        { opacity: 0, y: m.role === 'user' ? 8 : 14 },
        { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }
      )
    })
  }, [messages])

  // Stagger the greeting + topic cards + popular chips in on first mount /
  // whenever we return to the empty screen after "New chat".
  useLayoutEffect(() => {
    if (!isWelcome || !welcomeRef.current) return
    const ctx = gsap.context(() => {
      gsap.fromTo('.js-hero', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.5, ease: 'power2.out' })
      gsap.fromTo(
        '.js-tile',
        { opacity: 0, y: 12 },
        { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out', stagger: 0.05, delay: 0.12 }
      )
      gsap.fromTo(
        '.js-chip',
        { opacity: 0, y: 8 },
        { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out', stagger: 0.04, delay: 0.35 }
      )
    }, welcomeRef)
    return () => ctx.revert()
  }, [isWelcome])

  const sendMessage = async (text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    setTextInput('')

    const userMessage = { role: 'user', content: trimmed, timestamp: new Date() }
    setMessages(prev => [...prev, userMessage])
    setIsLoading(true)

    try {
      const res = await axios.post(`${API_BASE_URL}/chat`, { message: trimmed, sessionId })
      const { response, category, matchType, source, metadata, sessionId: returnedSessionId, intent, routerConfidence, criticFlags, actions } = res.data
      if (returnedSessionId && returnedSessionId !== sessionId) {
        setSessionId(returnedSessionId)
        try { sessionStorage.setItem(SESSION_STORAGE_KEY, returnedSessionId) } catch { /* best-effort */ }
      }
      setMessages(prev => [...prev, {
        role: 'bot',
        content: response,
        timestamp: new Date(),
        category,
        matchType,
        groqDown: metadata?.error === 'groq_failed',
        source,
        intent,
        routerConfidence,
        criticFlags,
        actions
      }])
      if (actions?.length) refreshTickets()
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'bot',
        content: "Couldn't reach the server just now. Try again in a moment.",
        timestamp: new Date(),
        matchType: 'fallback',
        networkError: true
      }])
    } finally {
      setIsLoading(false)
    }
  }

  const handleTopicClick = (topic) => sendMessage(topic.starter)
  const handleSubmit = (e) => { e.preventDefault(); sendMessage(textInput) }
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(textInput) }
  }

  // Starts a fresh session rather than deleting the old one's data — the
  // whole point of Stage 5 is that a session's history/tickets persist, so
  // "new chat" abandons the id instead of wiping it out of the database.
  const startNewChat = () => {
    setMessages([])
    setTextInput('')
    setSessionId(null)
    seenRows.current = new Set()
    try { sessionStorage.removeItem(SESSION_STORAGE_KEY) } catch { /* best-effort */ }
  }

  const focusInput = () => inputRef.current?.focus()

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background text-foreground">
      <header className="sticky top-0 z-20 flex shrink-0 items-center justify-between border-b border-border/70 bg-background/75 px-4 py-3 backdrop-blur-md md:px-6">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-full text-white shadow-glow"
            style={{ background: 'var(--gradient-brand)' }}
          >
            <Sparkles className="h-4 w-4" />
          </span>
          <span className="font-serif text-[16px] font-medium tracking-tight">OCC Assistant</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Sheet open={activityOpen} onOpenChange={setActivityOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5 rounded-full text-muted-foreground">
                <ListChecks className="h-4 w-4" />
                <span className="hidden sm:inline">Activity</span>
                {tickets.length > 0 && <Badge variant="primary">{tickets.length}</Badge>}
              </Button>
            </SheetTrigger>
            <SheetContent side="right">
              <ActivityPanel tickets={tickets} totalFAQs={totalFAQs} />
            </SheetContent>
          </Sheet>
          <Button variant="ghost" size="sm" className="gap-1.5 rounded-full text-muted-foreground" onClick={startNewChat}>
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New chat</span>
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isWelcome && (
          <div ref={welcomeRef} className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center gap-7 px-5 py-6">
            <div className="js-hero relative w-full shrink-0 overflow-hidden rounded-[28px] border border-border bg-panel px-6 py-11 text-center shadow-glow">
              <div
                className="animate-float-blob pointer-events-none absolute -top-24 -left-16 h-72 w-72 rounded-full opacity-[0.35] blur-3xl"
                style={{ background: 'var(--gradient-brand)' }}
              />
              <div
                className="animate-float-blob pointer-events-none absolute -bottom-28 -right-20 h-80 w-80 rounded-full opacity-[0.28] blur-3xl"
                style={{ background: 'var(--gradient-brand)', animationDelay: '2.6s' }}
              />
              <VantaGlobe className="pointer-events-none absolute right-1 top-1 h-28 w-28 opacity-90 sm:h-36 sm:w-36" />

              <div className="relative z-10 flex flex-col items-center gap-4">
                <div className="inline-flex items-center gap-2 rounded-full border border-border bg-panel/80 px-3.5 py-1.5 text-[11px] font-medium tracking-wide text-muted-foreground shadow-sm backdrop-blur">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
                  </span>
                  Live · answering from {totalFAQs} FAQs
                </div>

                <h1 className="max-w-md text-balance text-[30px] font-semibold leading-[1.1] tracking-tight text-foreground md:text-[38px]">
                  What do you need to <span className="font-serif italic font-medium text-gradient-brand">sort out</span>?
                </h1>
                <p className="max-w-sm text-[14px] leading-relaxed text-muted-foreground">
                  Housing, rent, transit, health, food, and campus rules — grounded in real OCC FAQ entries.
                </p>
              </div>
            </div>

            <div className="grid w-full shrink-0 grid-cols-2 gap-2.5 sm:grid-cols-3">
              {NAV_TOPICS.map(t => {
                const Icon = t.icon
                return (
                  <button
                    key={t.name}
                    onClick={() => handleTopicClick(t)}
                    className="js-tile group relative flex min-h-[88px] flex-col gap-2 overflow-hidden rounded-2xl border border-border bg-panel px-4 py-3 text-left shadow-sm transition-all duration-200 hover:-translate-y-1 hover:shadow-lg"
                  >
                    <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: dot(t.hue) }} />
                    <span
                      className="flex h-9 w-9 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-110"
                      style={{ background: wash(t.hue), color: dot(t.hue) }}
                    >
                      <Icon className="h-4.5 w-4.5" />
                    </span>
                    <span className="text-[13.5px] font-semibold text-foreground">{t.name}</span>
                    <span className="text-[11.5px] leading-snug text-muted-foreground">{t.hint}</span>
                  </button>
                )
              })}
            </div>

            <div className="flex w-full shrink-0 flex-col items-center gap-2.5">
              <div className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground/70 uppercase">Asked this week</div>
              <div className="flex flex-wrap justify-center gap-2">
                {POPULAR_QUESTIONS.map(q => (
                  <button
                    key={q}
                    onClick={() => sendMessage(q)}
                    className="js-chip rounded-full border border-border bg-panel px-3.5 py-2 text-[12.5px] text-foreground/80 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {!isWelcome && (
          <div className="mx-auto flex max-w-2xl flex-col gap-6 px-5 py-6 md:px-0">
            {messages.map((m, i) => (
              <div
                key={i}
                ref={(el) => {
                  if (el) rowRefs.current.set(i, el)
                  if (m.role === 'bot' && i === messages.length - 1) lastBotRowRef.current = el
                }}
              >
                {m.role === 'user' ? (
                  <div className="flex justify-end">
                    <div className="max-w-[75%] whitespace-pre-line rounded-2xl bg-muted px-4 py-2.5 text-[14.5px] leading-relaxed text-foreground">
                      {m.content}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-3">
                    <span
                      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white shadow-glow"
                      style={{ background: 'var(--gradient-brand)' }}
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1 flex-col gap-1.5">
                      <Badge variant={m.matchType === 'faq' ? 'primary' : 'default'} className="mb-1.5">
                        OCC · {m.matchType === 'faq' ? m.category : 'Fallback match'}
                      </Badge>
                      <div className="prose prose-sm max-w-none leading-relaxed text-foreground prose-headings:text-foreground prose-strong:text-foreground prose-a:text-primary prose-code:text-primary prose-blockquote:border-l-primary/50 prose-blockquote:text-muted-foreground prose-hr:border-border prose-th:text-foreground prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 first:prose-p:mt-0 last:prose-p:mb-0">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleanMarkdown(m.content)}</ReactMarkdown>
                      </div>
                      {m.groqDown && (
                        <div className="mt-1.5 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-2 text-xs leading-relaxed text-destructive">
                          Groq is unavailable right now — this is a fallback keyword match, not a generated answer.
                        </div>
                      )}
                      {!m.groqDown && m.matchType === 'fallback' && !m.networkError && (
                        <div className="mt-1 text-[11.5px] text-muted-foreground/70">No specific FAQ matched — this answer draws on general knowledge instead.</div>
                      )}
                      {!m.networkError && (
                        <div className="mt-1.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground/60">{traceSummary(m)}</div>
                      )}
                      <div className="mt-1 font-mono text-[10px] text-muted-foreground/50">{formatTime(m.timestamp)}</div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <Button variant="outline" size="sm" className="h-auto rounded-full px-3 py-1.5 text-[12.5px] font-normal" onClick={focusInput}>
                          Ask something else
                        </Button>
                        <Button variant="outline" size="sm" className="h-auto rounded-full px-3 py-1.5 text-[12.5px] font-normal" onClick={startNewChat}>
                          Start a new topic
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
            {isLoading && (
              <div className="flex items-start gap-3">
                <span
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white shadow-glow"
                  style={{ background: 'var(--gradient-brand)' }}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                </span>
                <div className="flex items-center gap-2 pt-1.5 font-mono text-xs text-muted-foreground">
                  Checking the {totalFAQs}-FAQ index
                  <span className="flex gap-1">
                    {[0, 1, 2].map(i => (
                      <span
                        key={i}
                        className="h-1 w-1 animate-bounce rounded-full bg-primary"
                        style={{ animationDelay: `${i * 0.15}s` }}
                      />
                    ))}
                  </span>
                </div>
              </div>
            )}
            <div ref={bodyEndRef} />
          </div>
        )}
      </div>

      <div className="shrink-0 px-4 pb-4 md:px-0">
        <form
          onSubmit={handleSubmit}
          className="mx-auto flex max-w-2xl items-end gap-2 rounded-full border border-border bg-panel px-4 py-2 shadow-sm transition-shadow duration-200 focus-within:border-transparent focus-within:shadow-glow"
        >
          <Textarea
            ref={inputRef}
            rows={1}
            placeholder="Ask about leases, rent, transit, food, anything off campus…"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isLoading}
            className="max-h-[120px] py-2"
          />
          <button
            type="submit"
            disabled={isLoading || !textInput.trim()}
            aria-label="Send"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white transition-transform duration-150 disabled:cursor-not-allowed disabled:opacity-40 enabled:hover:scale-105"
            style={{ background: 'var(--gradient-brand)' }}
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        </form>
        <div className="mx-auto mt-2 max-w-2xl text-center text-[11px] leading-relaxed text-muted-foreground/70">
          General guidance only, not official advice — check anything urgent with WUSA or UW directly.
        </div>
      </div>
    </div>
  )
}

export default Chatbot
